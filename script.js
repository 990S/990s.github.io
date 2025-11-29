// --- 定数と状態変数 ---
const MAX_G = 9.80665; // 1G (m/s^2)
const MAX_DISPLACEMENT = 150; // メーターの半径 (CSSのwidth/2)
const DECLINE_THRESHOLD = 0.3; // G抜け判定の減少幅 (G)
const SLIP_PEAK_MIN = 0.4; // 判定前の最小G
const COOLDOWN_MS = 3000; // 警告音のクールダウン時間 (ms)
const HISTORY_SIZE = 12; // 加速度履歴サイズ (約0.2秒分)

let initialGravity = { x: 0, y: 0 };
let isInitialized = false;
let maxGX = 0;
let maxGY = 0;
let lastWarningTime = 0;
let accelerationHistory = [];

// --- DOM要素 ---
const ball = document.getElementById('ball');
const statusText = document.getElementById('status-text');
const maxGxDisplay = document.getElementById('max-gx');
const maxGyDisplay = document.getElementById('max-gy');
const initButton = document.getElementById('request-permission');
const resetButton = document.getElementById('reset-max');

// --- サウンドプール (警告音はブラウザのAudioContextを使用) ---
let audioContext;
let oscillator;

function setupAudio() {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // 警告音の生成 (シンプルなトーン)
    oscillator = audioContext.createOscillator();
    oscillator.type = 'sine'; // サイン波
    oscillator.frequency.setValueAtTime(440, audioContext.currentTime); // 440 Hz
    
    const gainNode = audioContext.createGain();
    gainNode.gain.setValueAtTime(0.5, audioContext.currentTime); // ボリューム
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    // オシレーターは一度開始したら停止させずに、Gainで音量を制御する
    oscillator.start();
    gainNode.gain.setValueAtTime(0, audioContext.currentTime); // 初期状態はミュート
}

function playWarningSound() {
    const gainNode = audioContext.destination.gain;
    
    // 音を急に出し、すぐに止める (警告音)
    gainNode.setValueAtTime(0.5, audioContext.currentTime);
    gainNode.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.3); // 0.3秒で減衰
}


// --- センサーアクセスと初期化 ---

function requestSensorPermission() {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+ で権限を要求
        DeviceOrientationEvent.requestPermission()
            .then(permissionState => {
                if (permissionState === 'granted') {
                    setupAudio();
                    window.addEventListener('devicemotion', handleMotion);
                    statusText.textContent = 'センサーアクセス許可済';
                } else {
                    statusText.textContent = 'センサーアクセス拒否';
                }
            })
            .catch(error => {
                statusText.textContent = 'エラー: ' + error;
                console.error(error);
            });
    } else {
        // その他のブラウザ (Android/旧iOS)
        setupAudio();
        window.addEventListener('devicemotion', handleMotion);
        statusText.textContent = '計測開始 (初期化してください)';
    }
}

function initializeZeroPoint(event) {
    if (!event || !event.accelerationIncludingGravity) {
        statusText.textContent = '加速度データ取得不可';
        return;
    }

    const { x, y } = event.accelerationIncludingGravity;
    
    // 1. 現在の重力成分を記録
    initialGravity.x = x;
    initialGravity.y = y;

    // 2. 状態を更新
    isInitialized = true;
    maxGX = 0;
    maxGY = 0;
    accelerationHistory = [];

    statusText.textContent = '初期化完了 (G計測中)';
    updateDisplay();
}

// --- メインデータ処理 ---

function handleMotion(event) {
    const { accelerationIncludingGravity } = event;
    
    if (!accelerationIncludingGravity || !isInitialized) {
        // 未初期化の場合は、初期化イベントとして処理
        initializeZeroPoint(event);
        return;
    }

    // 1. 傾き補正 (重力成分の除去)
    const accelX = accelerationIncludingGravity.x - initialGravity.x; // 左右方向
    const accelY = accelerationIncludingGravity.y - initialGravity.y; // 前後方向
    
    // 2. 全加速度の大きさ（G単位）を計算
    const accelMagnitudeG = Math.sqrt(accelX * accelX + accelY * accelY) / MAX_G;
    
    // 3. スリップ判定と警告音
    updateHistory(accelMagnitudeG);
    checkAndTriggerSlipWarning(accelMagnitudeG);

    // 4. 最大加速度の更新
    const gX = Math.abs(accelX) / MAX_G;
    const gY = Math.abs(accelY) / MAX_G;
    
    if (gX > maxGX) maxGX = gX;
    if (gY > maxGY) maxGY = gY;

    // 5. ボールの位置の計算 (正規化)
    // -1.0〜1.0 にクリップし、移動量にスケーリング
    const normalizedX = Math.max(-1, Math.min(1, accelX / MAX_G));
    const normalizedY = Math.max(-1, Math.min(1, accelY / MAX_G));
    
    const offsetX = normalizedX * MAX_DISPLACEMENT;
    const offsetY = -normalizedY * MAX_DISPLACEMENT; // Y軸は画面座標に合わせて反転

    // 6. UIの更新
    ball.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`;
    updateDisplay();
}


// --- G抜けスリップ判定ロジック ---

function updateHistory(currentMagnitude) {
    accelerationHistory.push(currentMagnitude);
    if (accelerationHistory.length > HISTORY_SIZE) {
        accelerationHistory.shift(); // 古い要素を削除
    }
}

function checkAndTriggerSlipWarning(currentMagnitude) {
    if (accelerationHistory.length !== HISTORY_SIZE) return;

    const peakMagnitude = Math.max(...accelerationHistory);
    const decline = peakMagnitude - currentMagnitude;
    const currentTime = Date.now();

    // 判定条件: 減少幅が閾値を超え、かつクールダウン期間外である
    if (decline >= DECLINE_THRESHOLD && peakMagnitude >= SLIP_PEAK_MIN && (currentTime - lastWarningTime) > COOLDOWN_MS) {
        playWarningSound();
        lastWarningTime = currentTime;
        console.log(`🚨 G抜け警告！ ピーク: ${peakMagnitude.toFixed(2)} G -> 現在: ${currentMagnitude.toFixed(2)} G`);
    }
}

// --- UI表示とイベントリスナー ---

function updateDisplay() {
    maxGxDisplay.textContent = maxGX.toFixed(2);
    maxGyDisplay.textContent = maxGY.toFixed(2);
}

function resetMaxG() {
    maxGX = 0;
    maxGY = 0;
    updateDisplay();
}

// イベントリスナーの登録
window.onload = () => {
    // iOS 13以降ではユーザー操作による権限要求が必要
    initButton.addEventListener('click', requestSensorPermission);
    resetButton.addEventListener('click', resetMaxG);
    
    // 非iOS環境での自動初期化と計測開始
    if (typeof DeviceOrientationEvent.requestPermission !== 'function') {
        requestSensorPermission();
    }
    
    // 警告音のセットアップ (ユーザー操作が必要なため、ボタンクリック後に実行)
    // setupAudio(); は requestSensorPermission 内で実行されます
};

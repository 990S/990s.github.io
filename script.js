// --- 定数と状態変数 ---
const MAX_G = 9.80665; // 1G (m/s^2)
const MAX_DISPLACEMENT = 150; // メーターの半径 (CSSのwidth/2)
const DECLINE_THRESHOLD = 0.3; // G抜け判定の減少幅 (G)
const SLIP_PEAK_MIN = 0.4; // 判定前の最小G
const COOLDOWN_MS = 3000; // 警告音のクールダウン時間 (ms)
const HISTORY_SIZE = 12; // 加速度履歴サイズ (約0.2秒分: 60FPS時)

let initialGravity = { x: 0, y: 0 };
let isInitialized = false;
let maxGX = 0;
let maxGY = 0;
let lastWarningTime = 0;
let accelerationHistory = [];
let currentOrientation = 0; // 0:ポートレート, 90/-90:ランドスケープ

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
let gainNode;

function setupAudio() {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        // 警告音の生成 (シンプルなトーン)
        oscillator = audioContext.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(440, audioContext.currentTime);
        
        gainNode = audioContext.createGain();
        gainNode.gain.setValueAtTime(0.5, audioContext.currentTime); 
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.start();
        gainNode.gain.setValueAtTime(0, audioContext.currentTime); // 初期状態はミュート
    } catch (e) {
        console.error("Audio Contextのセットアップに失敗しました。", e);
        statusText.textContent = '警告音機能が無効です。';
    }
}

function playWarningSound() {
    if (!gainNode || !audioContext) return;
    
    // 音を急に出し、すぐに止める (警告音)
    gainNode.gain.setValueAtTime(0.5, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.3); // 0.3秒で減衰
}


// --- センサーアクセスと初期化 ---

function requestSensorPermission() {
    // 【iOS 13+ 対応】
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
            .then(permissionState => {
                if (permissionState === 'granted') {
                    setupListeners();
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
        setupListeners();
    }
}

function setupListeners() {
    setupAudio();
    window.addEventListener('devicemotion', handleMotion);
    window.addEventListener('orientationchange', updateOrientation);
    statusText.textContent = '計測開始 (初期化してください)';
    
    // センサーリスナーを登録したら、すぐに現在の向きを取得して初期化
    currentOrientation = window.orientation || 0;
    statusText.textContent = 'センサーアクセス許可済';
}

function updateOrientation() {
    // デバイスの向き (0, 90, -90, 180) を取得
    currentOrientation = window.orientation || 0;
    // 向きが変わったら再初期化を促す
    if (isInitialized) {
        statusText.textContent = '向きが変わりました。再度初期化してください。';
        isInitialized = false;
    }
}

function initializeZeroPoint(event) {
    if (!event || !event.accelerationIncludingGravity) {
        statusText.textContent = '加速度データ取得不可';
        return;
    }
    
    // 1. 初期化時のデバイスの向きを取得
    currentOrientation = window.orientation || 0;

    // 2. 現在の重力成分を記録する
    const { x, y } = event.accelerationIncludingGravity;

    initialGravity.x = x;
    initialGravity.y = y;

    // 3. 状態を更新
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
    
    if (!accelerationIncludingGravity) return;

    if (!isInitialized) {
        // 初期化がまだの場合は、最初のデータを使って初期化
        initializeZeroPoint(event);
        return;
    }

    // 1. デバイス座標系での純粋な加速度を計算 (傾き補正)
    let rawAccelX = accelerationIncludingGravity.x - initialGravity.x;
    let rawAccelY = accelerationIncludingGravity.y - initialGravity.y;
    
    let accelX_screen; // 左右（画面横）方向の加速度
    let accelY_screen; // 前後（画面縦）方向の加速度

    // 2. 【重要】デバイスの向きに応じて軸をマッピングし、画面座標系に固定
    
    if (currentOrientation === 0 || currentOrientation === 180) { // ポートレート (縦向き)
        // 左右 = デバイスX軸, 前後 = デバイスY軸
        accelX_screen = rawAccelX;
        accelY_screen = rawAccelY * (currentOrientation === 0 ? 1 : -1); 
        
    } else { // ランドスケープ (横向き: 90 または -90)
        // 左右 (画面横) <-> デバイスY軸, 前後 (画面縦) <-> デバイスX軸
        
        if (currentOrientation === 90) { // ホームボタン右側 (標準的な車載設置)
            accelX_screen = rawAccelY; 
            accelY_screen = -rawAccelX; // 加速で上に動くように調整
        } else { // ホームボタン左側
            accelX_screen = -rawAccelY;
            accelY_screen = rawAccelX;
        }
    }
    
    // 3. 全加速度の大きさ（G単位）を計算
    const accelMagnitudeG = Math.sqrt(accelX_screen * accelX_screen + accelY_screen * accelY_screen) / MAX_G;
    
    // 4. スリップ判定と警告音
    updateHistory(accelMagnitudeG);
    checkAndTriggerSlipWarning(accelMagnitudeG);

    // 5. 最大加速度の更新
    const gX = Math.abs(accelX_screen) / MAX_G;
    const gY = Math.abs(accelY_screen) / MAX_G;
    
    if (gX > maxGX) maxGX = gX;
    if (gY > maxGY) maxGY = gY;

    // 6. ボールの位置の計算とUI更新
    const normalizedX = Math.max(-1, Math.min(1, accelX_screen / MAX_G));
    const normalizedY = Math.max(-1, Math.min(1, accelY_screen / MAX_G));
    
    const offsetX = normalizedX * MAX_DISPLACEMENT;
    const offsetY = -normalizedY * MAX_DISPLACEMENT; // Y軸は画面座標に合わせて反転

    ball.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`;
    updateDisplay();
}


// --- G抜けスリップ判定ロジック ---

function updateHistory(currentMagnitude) {
    accelerationHistory.push(currentMagnitude);
    if (accelerationHistory.length > HISTORY_SIZE) {
        accelerationHistory.shift();
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
    initButton.addEventListener('click', requestSensorPermission);
    resetButton.addEventListener('click', resetMaxG);
    
    // 非iOS環境での自動初期化と計測開始
    if (typeof DeviceOrientationEvent.requestPermission !== 'function') {
        requestSensorPermission();
    }
    
    // ページロード時に現在の向きを取得
    updateOrientation();
};

// --- 定数と状態変数 ---
const MAX_G = 9.80665; // 1G (m/s^2)
const MAX_DISPLACEMENT = 150; // メーターの半径 (CSSのwidth/2)
const DECLINE_THRESHOLD = 0.3; // G抜け判定の減少幅 (G)
const SLIP_PEAK_MIN = 0.4; // 判定前の最小G
const COOLDOWN_MS = 3000; // 警告音のクールダウン時間 (ms)
const HISTORY_SIZE = 12; // 加速度履歴サイズ (約0.2秒分: 60FPS時)

// initialGravityには、静止時のX, Y, Z軸の重力成分全てを記録します
let initialGravity = { x: 0, y: 0, z: 0 }; 
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

// --- サウンドプール ---
let audioContext;
let oscillator;
let gainNode;

function setupAudio() {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
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
    gainNode.gain.setValueAtTime(0.5, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.3);
}


// --- センサーアクセスと初期化 ---

function requestSensorPermission() {
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
        setupListeners();
    }
}

function setupListeners() {
    setupAudio();
    window.addEventListener('devicemotion', handleMotion);
    window.addEventListener('orientationchange', updateOrientation);
    currentOrientation = window.orientation || 0;
    statusText.textContent = 'センサーアクセス許可済';
}

function updateOrientation() {
    currentOrientation = window.orientation || 0;
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
    
    currentOrientation = window.orientation || 0;

    // 静止時のX, Y, Z軸の重力成分すべてを記録
    const { x, y, z } = event.accelerationIncludingGravity;
    initialGravity.x = x;
    initialGravity.y = y;
    initialGravity.z = z; 

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
        initializeZeroPoint(event);
        return;
    }

    // 1. 重力成分の除去 (純粋なユーザー加速度を抽出)
    let userAccelX = accelerationIncludingGravity.x - initialGravity.x;
    let userAccelY = accelerationIncludingGravity.y - initialGravity.y;

    // 2. ダッシュボード垂直設置時の軸マッピング
    
    let accelX_screen; // 左右（画面横）方向の加速度
    let accelY_screen; // 前後（画面縦）方向の加速度

    // iPhoneは横向き（ランドスケープ）で設置されていることを前提とする
    if (currentOrientation === 90) { // ホームボタン右側を右とする（一般的な車載配置）
        // 左右 (画面横) の動き = デバイスX軸 (userAccelX)
        accelX_screen = userAccelX; 
        // 前後 (画面縦) の動き = デバイスY軸 (-userAccelY)。
        accelY_screen = -userAccelY; 
    } else if (currentOrientation === -90) { // ホームボタン左側
        // 左右 (画面横) の動き = -userAccelX
        accelX_screen = -userAccelX;
        // 前後 (画面縦) の動き = userAccelY
        accelY_screen = userAccelY;
    } else { 
        statusText.textContent = '向きが不正です。横向きにしてください。';
        return;
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
    const normalizedX = accelX_screen / MAX_G;
    const normalizedY = accelY_screen / MAX_G;
    
    // 【重要修正】ボールの動きの方向をすべて反転させる
    // 画面X軸: +G(右カーブで左G) のときに、ボールを右(+)に動かしたい -> 符号を反転させる (-normalizedX)
    // 画面Y軸: +G(加速で後ろG) のときに、ボールを下(+)に動かしたい -> 符号を反転させる (-normalizedY)
    
    const offsetX = -normalizedX * MAX_DISPLACEMENT; // 左右反転
    const offsetY = -normalizedY * MAX_DISPLACEMENT; // 前後反転

    // ボールがメーターからはみ出さないようにクリップ
    const clipX = Math.max(-MAX_DISPLACEMENT, Math.min(MAX_DISPLACEMENT, offsetX));
    const clipY = Math.max(-MAX_DISPLACEMENT, Math.min(MAX_DISPLACEMENT, offsetY));


    ball.style.transform = `translate(calc(-50% + ${clipX}px), calc(-50% + ${clipY}px))`;
    updateDisplay();
}


// --- G抜けスリップ判定ロジック (変更なし) ---

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

    if (decline >= DECLINE_THRESHOLD && peakMagnitude >= SLIP_PEAK_MIN && (currentTime - lastWarningTime) > COOLDOWN_MS) {
        playWarningSound();
        lastWarningTime = currentTime;
        console.log(`🚨 G抜け警告！ ピーク: ${peakMagnitude.toFixed(2)} G -> 現在: ${currentMagnitude.toFixed(2)} G`);
    }
}

// --- UI表示とイベントリスナー (変更なし) ---

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
    
    if (typeof DeviceOrientationEvent.requestPermission !== 'function') {
        requestSensorPermission();
    }
    
    updateOrientation();
};

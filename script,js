// --- 定数と状態変数 ---
const MAX_G = 9.80665; 
const MAX_DISPLACEMENT = 125; // メーターの半径 (250px / 2)
const FILTER_ALPHA = 0.2; // EMA平滑化係数
const DECLINE_THRESHOLD = 0.3; 
const SLIP_PEAK_MIN = 0.4; 
const COOLDOWN_MS = 3000; 
const HISTORY_SIZE = 12; 
const TRACE_DURATION_MS = 1000; // 【追加】残像が残る時間 (1秒)
const TRACE_INTERVAL_MS = 50;   // 【追加】残像を記録する間隔 (50msごと)

let initialGravity = { x: 0, y: 0, z: 0 }; 
let isInitialized = false;
let maxGX = 0;
let maxGY = 0;
let lastWarningTime = 0;
let accelerationHistory = [];
let currentOrientation = 0; 
let filteredPosition = { x: 0, y: 0 }; 

let traceHistory = []; // 【追加】残像データ (位置とタイムスタンプ)
let lastTraceTime = 0;

// --- DOM要素 ---
const ball = document.getElementById('ball');
const traceContainer = document.getElementById('ball-trace-container'); // 【追加】
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
    filteredPosition = { x: 0, y: 0 }; 
    traceHistory = []; // 【修正】残像履歴も初期化

    statusText.textContent = '初期化完了 (G計測中)';
    updateDisplay();
}

// --- メインデータ処理 ---

function handleMotion(event) {
    const { accelerationIncludingGravity } = event;
    const currentTime = Date.now(); 

    if (!accelerationIncludingGravity) return;

    if (!isInitialized) {
        initializeZeroPoint(event);
        return;
    }

    // 1. 重力成分の除去 (純粋なユーザー加速度を抽出)
    let userAccelY = accelerationIncludingGravity.y - initialGravity.y;
    let userAccelZ = accelerationIncludingGravity.z - initialGravity.z;
    
    // 2. 軸マッピング
    
    let accelX_car; 
    let accelY_car; 
    
    if (currentOrientation === 90) { 
        accelY_car = -userAccelZ; 
        accelX_car = -userAccelY; 
    } else if (currentOrientation === -90) { 
        accelY_car = -userAccelZ;
        accelX_car = userAccelY; 
    } else { 
        return;
    }
    
    // 3. 全加速度の大きさ（G単位）を計算
    const accelMagnitudeG = Math.sqrt(accelX_car * accelX_car + accelY_car * accelY_car) / MAX_G;
    
    // 4. スリップ判定と警告音
    updateHistory(accelMagnitudeG);
    checkAndTriggerSlipWarning(accelMagnitudeG);

    // 5. 最大加速度の更新
    const gX = Math.abs(accelX_car) / MAX_G;
    const gY = Math.abs(accelY_car) / MAX_G;
    
    if (gX > maxGX) maxGX = gX;
    if (gY > maxGY) maxGY = gY;

    // 6. 生のボール位置の計算
    const normalizedX = accelX_car / MAX_G; 
    const normalizedY = accelY_car / MAX_G; 
    
    const rawOffsetX = normalizedX * MAX_DISPLACEMENT; 
    const rawOffsetY = -normalizedY * MAX_DISPLACEMENT; 

    // 7. 指数移動平均 (EMA) フィルタの適用
    filteredPosition.x = (FILTER_ALPHA * rawOffsetX) + ((1 - FILTER_ALPHA) * filteredPosition.x);
    filteredPosition.y = (FILTER_ALPHA * rawOffsetY) + ((1 - FILTER_ALPHA) * filteredPosition.y);


    // 8. ボールがメーターからはみ出さないようにクリップ
    const clipX = Math.max(-MAX_DISPLACEMENT, Math.min(MAX_DISPLACEMENT, filteredPosition.x));
    const clipY = Math.max(-MAX_DISPLACEMENT, Math.min(MAX_DISPLACEMENT, filteredPosition.y));
    
    // 9. UI更新 (ボールの位置を更新)
    ball.style.transform = `translate(calc(-50% + ${clipX}px), calc(-50% + ${clipY}px))`;
    updateDisplay();
    
    // 10. 【追加】残像の記録と描画
    if (currentTime - lastTraceTime > TRACE_INTERVAL_MS) {
        traceHistory.push({ x: clipX, y: clipY, time: currentTime });
        lastTraceTime = currentTime;
    }
    renderTrace(currentTime); // 毎フレーム描画を呼び出す
}


// --- 【追加】残像描画ロジック ---

function renderTrace(currentTime) {
    // 古い残像を削除
    while (traceHistory.length > 0 && currentTime - traceHistory[0].time > TRACE_DURATION_MS) {
        traceHistory.shift();
    }
    
    // コンテナ内の既存の残像をクリア（再描画が重い場合はDOMプールを使うが、ここではシンプルに毎回クリア）
    traceContainer.innerHTML = '';

    // 新しい残像を描画
    traceHistory.forEach(dot => {
        const age = currentTime - dot.time;
        // 時間経過で 1.0 から 0.0 まで透明度を減少させる
        const opacity = 1.0 - (age / TRACE_DURATION_MS);
        
        const traceDot = document.createElement('div');
        traceDot.className = 'trace-dot';
        
        // メーターコンテナの幅/高さ (250px) の中心 (125px) を基準に位置を設定
        traceDot.style.transform = `translate(calc(125px + ${dot.x}px), calc(125px + ${dot.y}px))`;
        traceDot.style.opacity = opacity;
        
        traceContainer.appendChild(traceDot);
    });
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

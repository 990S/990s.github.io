document.addEventListener('DOMContentLoaded', () => {
    // --- 定数とDOM要素の取得 ---
    const canvas = document.getElementById('g-meter-canvas');
    const ctx = canvas.getContext('2d');
    const gDisplay = document.getElementById('g-display');
    const logElement = document.getElementById('log');
    const requestPermissionButton = document.getElementById('request-permission');
    const resetMaxGButton = document.getElementById('reset-max-g');
    
    // 新しいボタン要素を取得
    const flipSideBtn = document.getElementById('flip-side-btn');
    const flipForwardBtn = document.getElementById('flip-forward-btn');
    
    const warningSound = document.getElementById('warning-sound');

    if (!requestPermissionButton || !flipSideBtn || !flipForwardBtn) {
        if (logElement) {
             logElement.textContent = '致命的エラー: ボタン要素が見つかりません。HTML IDを確認してください。';
        }
        console.error('Fatal Error: Button element not found.');
        return;
    }
    
    const maxGLeftElement = document.getElementById('max-g-left');
    const maxGRightElement = document.getElementById('max-g-right');
    const maxGForwardElement = document.getElementById('max-g-forward');
    const maxGBackwardElement = document.getElementById('max-g-backward');

    const METER_MAX_G = 0.7; 
    const BALL_RADIUS = 8; 
    const TRACE_TIME_S = 3.0; 
    const EMA_ALPHA = 0.08; 

    // --- 状態変数 ---
    let gravityOffset = { x: 0, y: 0, z: 0 }; 
    let isInitialized = false;
    let filteredG = { x: 0, y: 0 }; 
    let totalG = 0; 
    let tracePoints = []; 

    let maxG = { left: 0, right: 0, forward: 0, backward: 0 };
    let peakG = 0;
    let warningCooldown = false; 
    
    // 軸反転の状態を保持する変数 (デフォルトは反転なし: 1)
    let flipSide = 1; // 左右の符号を制御 (1 または -1)
    let flipForward = 1; // 前後の符号を制御 (1 または -1)

    // --- メーター描画関数 (省略) ---
    function drawMeter() {
        // ... (省略) ...
        
        const size = canvas.width;
        const center = size / 2;
        const radius = size / 2;

        ctx.clearRect(0, 0, size, size);
        ctx.strokeStyle = '#007aff';
        ctx.fillStyle = '#007aff';
        ctx.lineWidth = 1;
        
        // (中略 - グリッド、トレース、G値表示)

        // --- ボール（現在のG）の描画 ---
        
        const pixelX = filteredG.x * (radius / METER_MAX_G); 
        const pixelY = -filteredG.y * (radius / METER_MAX_G); 

        const distance = Math.sqrt(pixelX * pixelX + pixelY * pixelY);
        let drawX = center + pixelX;
        let drawY = center + pixelY;

        if (distance > radius) {
            const ratio = radius / distance;
            drawX = center + pixelX * ratio;
            drawY = center + pixelY * ratio;
        }

        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(drawX, drawY, BALL_RADIUS, 0, 2 * Math.PI);
        ctx.fill(); 

        tracePoints.push({ x: drawX, y: drawY, timestamp: performance.now() });
        
        gDisplay.textContent = `${totalG.toFixed(2)} G`;
    }

    function resizeCanvas() {
        const size = document.getElementById('gauge-area').offsetWidth; 
        canvas.width = size;
        canvas.height = size;
        drawMeter(); 
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    function updateMaxGDisplay() {
        maxGLeftElement.textContent = maxG.left.toFixed(2);
        maxGRightElement.textContent = maxG.right.toFixed(2);
        maxGForwardElement.textContent = maxG.forward.toFixed(2);
        maxGBackwardElement.textContent = maxG.backward.toFixed(2);
    }

    function checkWarning(currentG) {
        if (peakG >= 0.4 && currentG < peakG - 0.3) {
            if (true) { 
                // playWarningSound();
            }
            peakG = 0;
        }
        peakG = Math.max(peakG, currentG);
    }
    
    // --- センサー処理 (軸マッピングのコア修正) ---
    function handleDeviceMotion(event) {
        if (!isInitialized) return;

        const acc = event.accelerationIncludingGravity;
        if (!acc || acc.x === null || acc.y === null || acc.z === null) return; 

        // デバイス加速度 (重力成分除去)
        const gX_device = (acc.x - gravityOffset.x) / 9.80665;
        const gY_device = (acc.y - gravityOffset.y) / 9.80665;
        const gZ_device = (acc.z - gravityOffset.z) / 9.80665; 
        
        // **【反転ロジック修正】**
        
        // 基本の軸マッピング (Y軸を左右、Z軸を前後) に、flip変数を乗算して最終的な符号を制御
        
        // 1. 左右方向 (Y軸): Y軸にflipSideを乗算して符号を制御
        //    * 最初の設定で符号を反転させる (-gY_device) 処理は、flipSide に任せます。
        //    * ここで flipSide の初期値を -1 に変更し、ボタンが押されると 1 になるようにするか、
        //    * または、flipSide の初期値を 1 に戻し、Y軸の符号を外部から制御します。
        
        // 🎯 修正点: gY_device の符号を直接 flipSide で制御する 🎯
        // Y軸が本来の左右の動きの軸で、-1で反転させることで、ホームボタン左右問題を吸収し、
        // さらに flipSide でユーザー反転を可能にする。
        const g_side = gY_device * (-1 * flipSide); // -1 を乗算することで、デフォルトの反転を維持しつつ、flipSide でユーザー反転を可能にする

        // 2. 前後方向 (Z軸): Z軸に flipForward を乗算して符号を制御
        // 🎯 修正点: gZ_device の符号を直接 flipForward で制御する 🎯
        const g_forward = gZ_device * (-1 * flipForward); // -1 を乗算することで、デフォルトの反転を維持しつつ、flipForward でユーザー反転を可能にする
        
        // --- フィルタリング (EMA) ---
        filteredG.x = (g_side * EMA_ALPHA) + (filteredG.x * (1 - EMA_ALPHA)); 
        filteredG.y = (g_forward * EMA_ALPHA) + (filteredG.y * (1 - EMA_ALPHA)); 

        totalG = Math.sqrt(filteredG.x * filteredG.x + filteredG.y * filteredG.y);

        // --- 最大G記録の更新 ---
        if (filteredG.x > 0) { 
            maxG.left = Math.max(maxG.left, filteredG.x);
        } else { 
            maxG.right = Math.max(maxG.right, Math.abs(filteredG.x));
        }

        if (filteredG.y > 0) { 
            maxG.forward = Math.max(maxG.forward, filteredG.y);
        } else { 
            maxG.backward = Math.max(maxG.backward, Math.abs(filteredG.y));
        }

        updateMaxGDisplay();
        checkWarning(totalG);
        drawMeter();
    }
    
    // --- センサー初期化ロジック (省略) ---
    const initializeZeroPointAndStart = (event) => {
        window.removeEventListener('devicemotion', initializeZeroPointAndStart);

        const acc = event.accelerationIncludingGravity;
        if (!acc || acc.x === null || acc.y === null || acc.z === null) {
             logElement.textContent = 'ログ: センサーデータが不完全なため、初期化できませんでした。';
             return;
        }
        
        gravityOffset.x = acc.x;
        gravityOffset.y = acc.y;
        gravityOffset.z = acc.z;
        isInitialized = true;
        
        filteredG.x = 0;
        filteredG.y = 0;

        window.addEventListener('devicemotion', handleDeviceMotion);
        
        drawMeter(); 

        logElement.textContent = `ログ: センサー初期化完了。X: ${gravityOffset.x.toFixed(2)}, Y: ${gravityOffset.y.toFixed(2)}, Z: ${gravityOffset.z.toFixed(2)} をゼロ点に設定しました。`;
    };

    function startMotionTracking() {
        window.removeEventListener('devicemotion', handleDeviceMotion);
        window.removeEventListener('devicemotion', initializeZeroPointAndStart);

        logElement.textContent = 'ログ: センサーデータを取得し、ゼロ点を設定します...';
        
        window.addEventListener('devicemotion', initializeZeroPointAndStart);
    }
    
    // --- 新しいイベントハンドラ: 反転ボタンの処理 ---
    flipSideBtn.addEventListener('click', () => {
        flipSide *= -1; 
        const status = flipSide === 1 ? '通常' : '反転';
        logElement.textContent = `ログ: 左右の動きを${status}に設定しました。`;
    });

    flipForwardBtn.addEventListener('click', () => {
        flipForward *= -1; 
        const status = flipForward === 1 ? '通常' : '反転';
        logElement.textContent = `ログ: 前後の動きを${status}に設定しました。`;
    });


    // --- 既存のイベントハンドラ (省略) ---
    requestPermissionButton.addEventListener('click', () => {
        if (isInitialized) {
            logElement.textContent = 'ログ: 既にセンサーは初期化済みです。';
            return;
        }

        if (typeof DeviceMotionEvent.requestPermission === 'function') {
            logElement.textContent = 'ログ: センサー許可ポップアップを表示します...';
            
            DeviceMotionEvent.requestPermission().then(permissionState => {
                if (permissionState === 'granted') {
                    startMotionTracking();
                } else {
                    logElement.textContent = 'ログ: センサーの使用が拒否されました。設定を確認してください。';
                }
            }).catch(error => {
                if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
                    logElement.innerHTML = 'ログ: ⛔ **エラー: ポップアップが出ません。** HTTPSまたはlocalhostでアクセスしてください。';
                } else {
                    logElement.textContent = 'ログ: センサー許可リクエスト中にエラーが発生しました: ' + error.message;
                }
            });
        } else {
            logElement.textContent = 'ログ: 許可不要な環境として、トラッキングを開始します。';
            startMotionTracking();
        }
    });
    
    resetMaxGButton.addEventListener('click', () => {
        maxG = { left: 0, right: 0, forward: 0, backward: 0 };
        updateMaxGDisplay();
        logElement.textContent = 'ログ: 最大G記録をリセットしました。';
    });
});

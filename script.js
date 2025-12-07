document.addEventListener('DOMContentLoaded', () => {
    // --- 定数とDOM要素の取得 (変更なし) ---
    const canvas = document.getElementById('g-meter-canvas');
    const ctx = canvas.getContext('2d');
    const gDisplay = document.getElementById('g-display');
    const logElement = document.getElementById('log');
    const requestPermissionButton = document.getElementById('request-permission');
    const resetMaxGButton = document.getElementById('reset-max-g');
    const warningSound = document.getElementById('warning-sound');

    if (!requestPermissionButton) {
        if (logElement) {
             logElement.textContent = '致命的エラー: 「センサー許可/初期化」ボタンが見つかりません。HTML IDを確認してください。';
        }
        console.error('Fatal Error: Button element with ID "request-permission" not found.');
        return;
    }
    
    const maxGLeftElement = document.getElementById('max-g-left');
    const maxGRightElement = document.getElementById('max-g-right');
    const maxGForwardElement = document.getElementById('max-g-forward');
    const maxGBackwardElement = document.getElementById('max-g-backward');

    const METER_MAX_G = 0.7;
    const BALL_RADIUS = 8;
    const TRACE_TIME_S = 3.0;
    const EMA_ALPHA = 0.3;

    // --- 状態変数 ---
    // 重力オフセットは3軸で記録
    let gravityOffset = { x: 0, y: 0, z: 0 }; 
    let isInitialized = false;
    // filteredG.x: 左右G (メーター横軸), filteredG.y: 前後G (メーター縦軸)
    let filteredG = { x: 0, y: 0 }; 
    let totalG = 0; 
    let tracePoints = []; 

    let maxG = { left: 0, right: 0, forward: 0, backward: 0 };
    let peakG = 0;
    let warningCooldown = false; 

    // --- ユーティリティ関数 (省略) ---
    function updateMaxGDisplay() {
        maxGLeftElement.textContent = maxG.left.toFixed(2);
        maxGRightElement.textContent = maxG.right.toFixed(2);
        maxGForwardElement.textContent = maxG.forward.toFixed(2);
        maxGBackwardElement.textContent = maxG.backward.toFixed(2);
    }
    // ... (resizeCanvas, playWarningSound, checkWarningは省略) ...

    function resizeCanvas() {
        const size = document.getElementById('gauge-area').offsetWidth; 
        canvas.width = size;
        canvas.height = size;
        drawMeter(); 
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);


    // --- メーター描画関数 (軸マッピング修正済み) ---
    function drawMeter() {
        const size = canvas.width;
        const center = size / 2;
        const radius = size / 2;

        ctx.clearRect(0, 0, size, size);
        ctx.strokeStyle = '#007aff';
        ctx.fillStyle = '#007aff';
        ctx.lineWidth = 1;
        
        // (目盛り、十字線、凡例、残像の描画は変更なし)
        ctx.setLineDash([5, 5]); 
        const r03 = radius * (0.3 / METER_MAX_G);
        ctx.beginPath();
        ctx.arc(center, center, r03, 0, 2 * Math.PI);
        ctx.stroke();
        const r06 = radius * (0.6 / METER_MAX_G);
        ctx.beginPath();
        ctx.arc(center, center, r06, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.setLineDash([]); 
        ctx.beginPath();
        ctx.moveTo(0, center);
        ctx.lineTo(size, center);
        ctx.moveTo(center, 0);
        ctx.lineTo(center, size);
        ctx.stroke();
        
        const now = performance.now();
        const maxTraceLife = TRACE_TIME_S * 1000;
        while (tracePoints.length > 0 && now - tracePoints[0].timestamp > maxTraceLife) {
            tracePoints.shift();
        }

        tracePoints.forEach(point => {
            const lifeRatio = (now - point.timestamp) / maxTraceLife; 
            const alpha = 1.0 - lifeRatio; 
            ctx.fillStyle = `rgba(255, 0, 0, ${alpha})`;
            ctx.beginPath();
            ctx.arc(point.x, point.y, 2, 0, 2 * Math.PI); 
            ctx.fill();
        });

        // --- ボール（現在のG）の描画 ---
        
        // filteredG.x (左右G) -> 画面上 X軸 (左右)
        const pixelX = filteredG.x * (radius / METER_MAX_G); 
        
        // filteredG.y (前後G) -> 画面上 Y軸 (Y軸は下がプラスなので反転: -filteredG.y)
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

        tracePoints.push({ x: drawX, y: drawY, timestamp: now });
        
        gDisplay.textContent = `${totalG.toFixed(2)} G`;
    }

    // --- センサー処理 (軸マッピングのコア修正) ---
    function handleDeviceMotion(event) {
        if (!isInitialized) return;

        const acc = event.accelerationIncludingGravity;
        if (!acc || acc.x === null || acc.y === null || acc.z === null) return; 

        // デバイス加速度 (重力成分除去)
        const gX_device = (acc.y - gravityOffset.y) / 9.80665;
        const gY_device = -(acc.x - gravityOffset.x) / 9.80665;
        const gZ_device = (acc.z - gravityOffset.z) / 9.80665; 
        
        // **【コア修正: 横向き・立てかけマッピング】**
        // 1. 前後方向 (上下の動き): Z軸を使用
        //    - 加速(前)は Zがプラス (+) の時、画面は上へ (filteredG.y +)
        const g_forward = gZ_device; 

        // 2. 左右方向 (左右の動き): X軸を使用 (Y軸だと左右反転の可能性あり)
        //    - 左旋回(左)は Xがマイナス (-) の時、画面は左へ (filteredG.x -)
        //    - → 符号を反転させる (マイナスが左、プラスが右、という直感的な表示にするため)
        const g_side = -gX_device; 

        // --- フィルタリング (EMA) ---
        // filteredG.x (左右G) ← g_side
        filteredG.x = (g_side * EMA_ALPHA) + (filteredG.x * (1 - EMA_ALPHA)); 
        // filteredG.y (前後G) ← g_forward
        filteredG.y = (g_forward * EMA_ALPHA) + (filteredG.y * (1 - EMA_ALPHA)); 

        totalG = Math.sqrt(filteredG.x * filteredG.x + filteredG.y * filteredG.y);

        // --- 最大G記録の更新 ---
        // X軸 (左右方向): +Xが左、-Xが右
        if (filteredG.x > 0) { // 左方向
            maxG.left = Math.max(maxG.left, filteredG.x);
        } else { // 右方向 
            maxG.right = Math.max(maxG.right, Math.abs(filteredG.x));
        }

        // Y軸 (前後方向): +Yが前(加速)、-Yが後(減速)
        if (filteredG.y > 0) { // 前方向 (加速)
            maxG.forward = Math.max(maxG.forward, filteredG.y);
        } else { // 後方向 (減速/ブレーキ)
            maxG.backward = Math.max(maxG.backward, Math.abs(filteredG.y));
        }

        updateMaxGDisplay();
        drawMeter();
    }
    
    // --- センサー初期化ロジック (3軸オフセットの記録) ---
    const initializeZeroPointAndStart = (event) => {
        window.removeEventListener('devicemotion', initializeZeroPointAndStart);

        const acc = event.accelerationIncludingGravity;

        if (!acc || acc.x === null || acc.y === null || acc.z === null) {
             logElement.textContent = 'ログ: センサーデータが不完全なため、初期化できませんでした。';
             return;
        }
        
        // 重力オフセットを3軸すべてで記録
        gravityOffset.x = acc.x;
        gravityOffset.y = acc.y;
        gravityOffset.z = acc.z;
        isInitialized = true;
        
        filteredG.x = 0;
        filteredG.y = 0;

        window.addEventListener('devicemotion', handleDeviceMotion);
        
        // 警告音の準備 (iOS対応)
        // ... (警告音の初期化処理は省略) ...

        logElement.textContent = `ログ: センサー初期化完了。X: ${gravityOffset.x.toFixed(2)}, Y: ${gravityOffset.y.toFixed(2)}, Z: ${gravityOffset.z.toFixed(2)} をゼロ点に設定しました。`;
    };

    function startMotionTracking() {
        window.removeEventListener('devicemotion', handleDeviceMotion);
        window.removeEventListener('devicemotion', initializeZeroPointAndStart);

        logElement.textContent = 'ログ: センサーデータを取得し、ゼロ点を設定します...';
        
        window.addEventListener('devicemotion', initializeZeroPointAndStart);
    }

    // --- イベントハンドラ (省略) ---
    requestPermissionButton.addEventListener('click', () => {
        console.log("ボタンクリックイベント発生！"); 

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
    
    // ... (resetMaxGButton のイベントハンドラは省略) ...
    resetMaxGButton.addEventListener('click', () => {
        maxG = { left: 0, right: 0, forward: 0, backward: 0 };
        updateMaxGDisplay();
        logElement.textContent = 'ログ: 最大G記録をリセットしました。';
    });
});

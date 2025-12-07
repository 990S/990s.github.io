document.addEventListener('DOMContentLoaded', () => {
    // --- 定数とDOM要素の取得 ---
    const canvas = document.getElementById('g-meter-canvas');
    const ctx = canvas.getContext('2d');
    const gDisplay = document.getElementById('g-display');
    const logElement = document.getElementById('log');
    const requestPermissionButton = document.getElementById('request-permission');
    const resetMaxGButton = document.getElementById('reset-max-g');
    const warningSound = document.getElementById('warning-sound');

    // **デバッグログの強化:** ボタンが取得できたかを確認
    if (!requestPermissionButton) {
        if (logElement) {
             logElement.textContent = '致命的エラー: 「センサー許可/初期化」ボタンが見つかりません。HTML IDを確認してください。';
        }
        console.error('Fatal Error: Button element with ID "request-permission" not found.');
        return; // 以降の処理を停止
    }
    
    // 最大G表示DOM要素
    const maxGLeftElement = document.getElementById('max-g-left');
    const maxGRightElement = document.getElementById('max-g-right');
    const maxGForwardElement = document.getElementById('max-g-forward');
    const maxGBackwardElement = document.getElementById('max-g-backward');

    const METER_MAX_G = 0.7; // メーターの最大表示範囲 (G)
    const BALL_RADIUS = 8; // ボールの半径 (px)
    const TRACE_TIME_S = 3.0; // 残像の表示時間 (秒)
    const EMA_ALPHA = 0.3; // 指数移動平均の平滑化係数

    // --- 状態変数 ---
    let gravityOffset = { x: 0, y: 0 }; 
    let isInitialized = false;
    let filteredG = { x: 0, y: 0 }; // x:左右G, y:前後G (メーター軸)
    let totalG = 0; 
    let tracePoints = []; 

    let maxG = { left: 0, right: 0, forward: 0, backward: 0 };
    let peakG = 0;
    let warningCooldown = false; 

    // --- メーター描画関数 ---
    function drawMeter() {
        const size = canvas.width;
        const center = size / 2;
        const radius = size / 2;

        ctx.clearRect(0, 0, size, size);
        ctx.strokeStyle = '#007aff';
        ctx.fillStyle = '#007aff';
        ctx.lineWidth = 1;
        
        // 目盛り円 (0.3G, 0.6G) - 点線
        ctx.setLineDash([5, 5]); 
        const r03 = radius * (0.3 / METER_MAX_G);
        ctx.beginPath();
        ctx.arc(center, center, r03, 0, 2 * Math.PI);
        ctx.stroke();

        const r06 = radius * (0.6 / METER_MAX_G);
        ctx.beginPath();
        ctx.arc(center, center, r06, 0, 2 * Math.PI);
        ctx.stroke();

        ctx.setLineDash([]); // 実線に戻す

        // 十字線
        ctx.beginPath();
        ctx.moveTo(0, center);
        ctx.lineTo(size, center);
        ctx.moveTo(center, 0);
        ctx.lineTo(center, size);
        ctx.stroke();

        // 凡例
        ctx.font = '12px Arial';
        ctx.textAlign = 'left'; 
        ctx.textBaseline = 'middle';
        ctx.fillText('0.3G', center + r03 + 5, center - 15);
        ctx.fillText('0.6G', center + r06 + 5, center - 15);
        ctx.textAlign = 'center';
        ctx.fillText('0G', center, center + 20);

        // 残像
        const now = performance.now();
        const maxTraceLife = TRACE_TIME_S * 1000;
        // 古い点の削除
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

        // --- 5. ボール（現在のG）の描画 (軸修正済み) ---
        
        // filteredG.x (左右G) -> 画面上 X軸 (左右)
        const pixelX = filteredG.x * (radius / METER_MAX_G); 
        
        // filteredG.y (前後G) -> 画面上 Y軸 (Y軸は下がプラスなので反転: -filteredG.y)
        const pixelY = -filteredG.y * (radius / METER_MAX_G); 

        // 合成Gが最大Gを超えないように制限
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

        // 残像に現在の点を追加
        tracePoints.push({ x: drawX, y: drawY, timestamp: now });
        
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

    function playWarningSound() {
        if (warningSound.readyState >= 2) {
            warningSound.currentTime = 0; 
            warningSound.play().catch(e => {});
        }
        logElement.textContent = `ログ: スリップ警告音を再生しました！ (G: ${totalG.toFixed(2)})`;
    }

    function checkWarning(currentG) {
        if (peakG >= 0.4 && currentG < peakG - 0.3) {
            if (!warningCooldown) {
                playWarningSound();
                warningCooldown = true;
                setTimeout(() => { warningCooldown = false; }, 1000);
            }
            peakG = 0;
        }
        peakG = Math.max(peakG, currentG);
    }
    
    // --- センサー処理 ---
    function handleDeviceMotion(event) {
        if (!isInitialized) return;

        const acc = event.accelerationIncludingGravity;
        if (!acc || acc.x === null) return; 

        // Gを算出 (加速度-オフセット)
        const gX_device = (acc.x - gravityOffset.x) / 9.80665; // デバイスX軸 (横方向のG)
        const gY_device = (acc.y - gravityOffset.y) / 9.80665; // デバイスY軸 (前後方向のG)
        
        // --- フィルタリング (EMA) ---
        // filteredG.x (左右G) ← デバイスX軸
        filteredG.x = (gX_device * EMA_ALPHA) + (filteredG.x * (1 - EMA_ALPHA)); 
        // filteredG.y (前後G) ← デバイスY軸
        filteredG.y = (gY_device * EMA_ALPHA) + (filteredG.y * (1 - EMA_ALPHA)); 

        totalG = Math.sqrt(filteredG.x * filteredG.x + filteredG.y * filteredG.y);

        // 最大G記録の更新
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
        checkWarning(totalG);
        drawMeter();
    }
    
    // --- センサー初期化ロジック ---
    const initializeZeroPointAndStart = (event) => {
        window.removeEventListener('devicemotion', initializeZeroPointAndStart);

        const acc = event.accelerationIncludingGravity;

        if (!acc || acc.x === null) {
             logElement.textContent = 'ログ: センサーデータが不完全なため、初期化できませんでした。';
             return;
        }
        
        // 初期化時の重力オフセットを設定
        gravityOffset.x = acc.x;
        gravityOffset.y = acc.y;
        isInitialized = true;
        
        filteredG.x = 0;
        filteredG.y = 0;

        window.addEventListener('devicemotion', handleDeviceMotion);
        
        // 警告音の準備 (iOS対応)
        warningSound.volume = 0;
        warningSound.play().catch(() => {});
        warningSound.volume = 1;

        logElement.textContent = `ログ: センサー初期化完了。X: ${gravityOffset.x.toFixed(2)} m/s², Y: ${gravityOffset.y.toFixed(2)} m/s² をゼロ点に設定しました。`;
    };

    function startMotionTracking() {
        window.removeEventListener('devicemotion', handleDeviceMotion);
        window.removeEventListener('devicemotion', initializeZeroPointAndStart);

        logElement.textContent = 'ログ: センサーデータを取得し、ゼロ点を設定します...';
        
        window.addEventListener('devicemotion', initializeZeroPointAndStart);
    }

    // --- イベントハンドラ ---
    requestPermissionButton.addEventListener('click', () => {
        console.log("ボタンクリックイベント発生！"); 

        if (isInitialized) {
            logElement.textContent = 'ログ: 既にセンサーは初期化済みです。';
            return;
        }

        // --- デバイスモーションセンサーのアクセス許可要求 ---
        if (typeof DeviceMotionEvent.requestPermission === 'function') {
            logElement.textContent = 'ログ: センサー許可ポップアップを表示します...';
            
            DeviceMotionEvent.requestPermission().then(permissionState => {
                if (permissionState === 'granted') {
                    startMotionTracking();
                } else {
                    logElement.textContent = 'ログ: センサーの使用が拒否されました。設定を確認してください。';
                }
            }).catch(error => {
                // HTTPS/localhost 外でのアクセスエラー対策
                if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
                    logElement.innerHTML = 'ログ: ⛔ **エラー: ポップアップが出ません。** HTTPSまたはlocalhostでアクセスしてください。';
                } else {
                    logElement.textContent = 'ログ: センサー許可リクエスト中にエラーが発生しました: ' + error.message;
                }
            });
        } else {
            // 許可が不要な環境 (Android, PCなど)
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

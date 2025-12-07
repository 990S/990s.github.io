document.addEventListener('DOMContentLoaded', () => {
    // --- 定数とDOM要素の取得 ---
    const canvas = document.getElementById('g-meter-canvas');
    const ctx = canvas.getContext('2d');
    const gDisplay = document.getElementById('g-display');
    const logElement = document.getElementById('log');
    const requestPermissionButton = document.getElementById('request-permission');
    const resetMaxGButton = document.getElementById('reset-max-g');
    const warningSound = document.getElementById('warning-sound');

    // 最大G表示DOM要素
    const maxGLeftElement = document.getElementById('max-g-left');
    const maxGRightElement = document.getElementById('max-g-right');
    const maxGForwardElement = document.getElementById('max-g-forward');
    const maxGBackwardElement = document.getElementById('max-g-backward');

    const METER_MAX_G = 0.7; // メーターの最大表示範囲 (G)
    const BALL_RADIUS = 8; // ボールの半径 (px)
    const TRACE_TIME_S = 3.0; // 残像の表示時間 (秒)
    const TRACE_POINTS_LIMIT = 300; // 残像の最大点数
    const EMA_ALPHA = 0.3; // 指数移動平均の平滑化係数

    // --- 状態変数 ---
    let gravityOffset = { x: 0, y: 0 }; // 初期化時の重力オフセット
    let isInitialized = false;
    let filteredG = { x: 0, y: 0 }; 
    let totalG = 0; 
    let tracePoints = []; 

    // 最大G記録
    let maxG = {
        left: 0,
        right: 0,
        forward: 0,
        backward: 0
    };

    // 警告音制御
    let peakG = 0;
    let warningCooldown = false; 

    // --- メーター描画関数 ---
    function drawMeter() {
        const size = canvas.width;
        const center = size / 2;
        const radius = size / 2;

        // Canvasをクリア
        ctx.clearRect(0, 0, size, size);

        // --- 1. 目盛り (0.3G, 0.6G) の描画 ---
        ctx.strokeStyle = '#007aff';
        ctx.fillStyle = '#007aff';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]); // 点線

        const r03 = radius * (0.3 / METER_MAX_G);
        ctx.beginPath();
        ctx.arc(center, center, r03, 0, 2 * Math.PI);
        ctx.stroke();

        const r06 = radius * (0.6 / METER_MAX_G);
        ctx.beginPath();
        ctx.arc(center, center, r06, 0, 2 * Math.PI);
        ctx.stroke();

        ctx.setLineDash([]); // 実線に戻す

        // --- 2. 十字線 (目盛りよりも上に描画することで目立たせる) ---
        ctx.beginPath();
        ctx.moveTo(0, center);
        ctx.lineTo(size, center);
        ctx.moveTo(center, 0);
        ctx.lineTo(center, size);
        ctx.stroke();


        // --- 3. 凡例の数値表示 (0.3G, 0.6G) ---
        ctx.font = '12px Arial';
        ctx.textAlign = 'left'; // 右側に寄せて描画
        ctx.textBaseline = 'middle';
        
        // 0.3G
        ctx.fillText('0.3G', center + r03 + 5, center - 15);
        // 0.6G
        ctx.fillText('0.6G', center + r06 + 5, center - 15);
        
        // 中央 (0G)
        ctx.textAlign = 'center';
        ctx.fillText('0G', center, center + 20);


        // --- 4. 残像（トレース）の描画 ---
        const now = performance.now();
        const maxTraceLife = TRACE_TIME_S * 1000;

        // 古い点を削除
        while (tracePoints.length > 0 && now - tracePoints[0].timestamp > maxTraceLife) {
            tracePoints.shift();
        }

        // 残像を描画
        tracePoints.forEach(point => {
            const lifeRatio = (now - point.timestamp) / maxTraceLife; 
            const alpha = 1.0 - lifeRatio; 

            ctx.fillStyle = `rgba(255, 0, 0, ${alpha})`;
            ctx.beginPath();
            ctx.arc(point.x, point.y, 2, 0, 2 * Math.PI); 
            ctx.fill();
        });

        // --- 5. ボール（現在のG）の描画 ---
        const pixelX = filteredG.x * (radius / METER_MAX_G); // 横方向 (+X: 左, -X: 右)
        const pixelY = -filteredG.y * (radius / METER_MAX_G); // 前後方向 (+Y: 前, -Y: 後)

        // 合成Gが最大Gを超えないように制限
        const distance = Math.sqrt(pixelX * pixelX + pixelY * pixelY);
        let drawX = center + pixelX;
        let drawY = center + pixelY;

        if (distance > radius) {
            const ratio = radius / distance;
            drawX = center + pixelX * ratio;
            drawY = center + pixelY * ratio;
        }

        // ボールを描画
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(drawX, drawY, BALL_RADIUS, 0, 2 * Math.PI);
        ctx.fill();

        // 残像に現在の点を追加
        tracePoints.push({
            x: drawX,
            y: drawY,
            timestamp: now
        });
        if (tracePoints.length > TRACE_POINTS_LIMIT) {
            tracePoints.shift();
        }

        // --- 6. 合成G値の表示 ---
        gDisplay.textContent = `${totalG.toFixed(2)} G`;
    }

    // Canvasサイズを調整
    function resizeCanvas() {
        // 親要素のサイズを使用
        const size = document.getElementById('gauge-area').offsetWidth; 
        canvas.width = size;
        canvas.height = size;
        drawMeter(); 
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // --- センサー処理 ---
    function handleDeviceMotion(event) {
        if (!isInitialized) return;

        const acc = event.accelerationIncludingGravity;
        if (!acc || acc.x === null || acc.y === null || acc.z === null) {
            logElement.textContent = 'ログ: センサーデータ取得エラー。';
            return;
        }

        // Gを算出 (加速度-オフセット)
        // デバイス横向き（ランドスケープ）を想定:
        //   - 車体X軸 (横G) は acc.x (デバイスの横方向)
        //   - 車体Y軸 (前後G) は acc.y (デバイスの縦方向)
        const gX = (acc.x - gravityOffset.x) / 9.80665; 
        const gY = (acc.y - gravityOffset.y) / 9.80665; 

        // --- フィルタリング (EMA) ---
        filteredG.x = (gX * EMA_ALPHA) + (filteredG.x * (1 - EMA_ALPHA));
        filteredG.y = (gY * EMA_ALPHA) + (filteredG.y * (1 - EMA_ALPHA));

        // 合成Gの計算
        totalG = Math.sqrt(filteredG.x * filteredG.x + filteredG.y * filteredG.y);

        // --- 最大G記録の更新 ---
        if (filteredG.x > 0) { // 左方向 (+X)
            maxG.left = Math.max(maxG.left, filteredG.x);
        } else { // 右方向 (-X)
            maxG.right = Math.max(maxG.right, Math.abs(filteredG.x));
        }

        if (filteredG.y > 0) { // 前方向 (加速, +Y)
            maxG.forward = Math.max(maxG.forward, filteredG.y);
        } else { // 後方向 (減速/ブレーキ, -Y)
            maxG.backward = Math.max(maxG.backward, Math.abs(filteredG.y));
        }

        updateMaxGDisplay();

        // --- 警告音処理 ---
        checkWarning(totalG);

        // --- 描画 ---
        drawMeter();
    }

    function updateMaxGDisplay() {
        maxGLeftElement.textContent = maxG.left.toFixed(2);
        maxGRightElement.textContent = maxG.right.toFixed(2);
        maxGForwardElement.textContent = maxG.forward.toFixed(2);
        maxGBackwardElement.textContent = maxG.backward.toFixed(2);
    }

    function checkWarning(currentG) {
        // ピークGが 0.4G以上、かつ現在のGがピークGより 0.3G以上低下
        if (peakG >= 0.4 && currentG < peakG - 0.3) {
            if (!warningCooldown) {
                playWarningSound();
                warningCooldown = true;
                setTimeout(() => { warningCooldown = false; }, 1000);
            }
            // 警告発生後はピークGをリセットして、次の強いGを待つ
            peakG = 0;
        }

        // ピークGを更新
        peakG = Math.max(peakG, currentG);
    }

    function playWarningSound() {
        if (warningSound.readyState >= 2) {
            warningSound.currentTime = 0; 
            warningSound.play().catch(e => {
                logElement.textContent = 'ログ: 警告音の再生に失敗しました。' + e;
            });
        }
        logElement.textContent = `ログ: スリップ警告音を再生しました！ (G: ${totalG.toFixed(2)})`;
    }

    // --- イベントハンドラ ---
    function startMotionTracking() {
        // DeviceMotionイベントが取得できるまで待ち、ゼロ点を初期化する
        const listener = (event) => {
            const acc = event.accelerationIncludingGravity;
            if (acc && acc.x !== null) {
                // 初めて有効なデータが取得できたら初期化を実行
                window.removeEventListener('devicemotion', listener);
                initializeZeroPoint(event);
            } else {
                // データの準備ができていない場合は待機
                logElement.textContent = 'ログ: センサーデータを待機中...';
            }
        };

        window.addEventListener('devicemotion', listener);
        logElement.textContent = 'ログ: センサーデータを取得し、ゼロ点を設定します...';
    }


    requestPermissionButton.addEventListener('click', () => {
        // iOS 13+ で必要な DeviceMotion の許可リクエスト
        if (typeof DeviceMotionEvent.requestPermission === 'function') {
            DeviceMotionEvent.requestPermission().then(permissionState => {
                if (permissionState === 'granted') {
                    startMotionTracking();
                } else {
                    logElement.textContent = 'ログ: センサーの使用が拒否されました。';
                }
            }).catch(error => {
                logElement.textContent = 'ログ: センサー許可リクエスト中にエラーが発生しました。' + error;
            });
        } else {
            // Android, PCなど、許可が不要な環境
            startMotionTracking();
        }
    });

    function initializeZeroPoint(event) {
        const acc = event.accelerationIncludingGravity;

        // この時点の重力成分をオフセットとして記録
        gravityOffset.x = acc.x;
        gravityOffset.y = acc.y;
        isInitialized = true;
        
        filteredG.x = 0;
        filteredG.y = 0;

        // 以降、通常のモーション処理を開始
        window.addEventListener('devicemotion', handleDeviceMotion);
        
        // 警告音再生のためのユーザーインタラクション確保
        warningSound.volume = 0;
        warningSound.play().catch(() => {});
        warningSound.volume = 1;

        logElement.textContent = `ログ: センサー初期化完了。X: ${gravityOffset.x.toFixed(2)} m/s², Y: ${gravityOffset.y.toFixed(2)} m/s² をゼロ点に設定しました。`;
    }
    
    resetMaxGButton.addEventListener('click', () => {
        maxG = { left: 0, right: 0, forward: 0, backward: 0 };
        updateMaxGDisplay();
        logElement.textContent = 'ログ: 最大G記録をリセットしました。';
    });
});

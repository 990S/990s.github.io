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
    
    // 最大G表示のIDをHTMLの新しい配置に合わせる
    const maxGLeftElement = document.getElementById('value-left');
    const maxGRightElement = document.getElementById('value-right');
    const maxGForwardElement = document.getElementById('value-forward');
    const maxGBackwardElement = document.getElementById('value-backward');

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
    let flipSide = 1; 
    let flipForward = 1; 

    // --- メーター描画関数 ---
    function drawMeter() {
        const size = canvas.width;
        const center = size / 2;
        const radius = size / 2;

        ctx.clearRect(0, 0, size, size);
        ctx.strokeStyle = '#007aff';
        ctx.fillStyle = '#007aff';
        ctx.lineWidth = 1;
        
        // グリッド、十字線
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
        
        // トレースの描画と寿命管理
        const now = performance.now();
        const maxTraceLife = TRACE_TIME_S * 1000;
        while (tracePoints.length > 0 && now - tracePoints[0].timestamp > maxTraceLife) {
            tracePoints.shift();
        }

        tracePoints.forEach(

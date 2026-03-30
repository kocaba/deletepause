// Состояние вкладок
let currentMode = 'auto'; 

// Переключение табов
document.getElementById("tabAuto").onclick = () => switchTab('auto');
document.getElementById("tabManual").onclick = () => switchTab('manual');

function switchTab(mode) {
    currentMode = mode;
    document.getElementById("tabAuto").style.background = mode === 'auto' ? 'var(--primary)' : 'none';
    document.getElementById("tabAuto").style.color = mode === 'auto' ? 'white' : '#333';
    document.getElementById("tabManual").style.background = mode === 'manual' ? 'var(--primary)' : 'none';
    document.getElementById("tabManual").style.color = mode === 'manual' ? 'white' : '#333';
    document.getElementById("manualControls").style.display = mode === 'manual' ? 'block' : 'none';
    document.getElementById("autoInfo").style.display = mode === 'auto' ? 'block' : 'none';
    drawWaveform();
}

// Функция автоматического подбора параметров
function getAutoParams() {
    if (!cachedRMS || cachedRMS.length === 0) return { db: -35, dur: 0.5 };

    // 1. Находим "тихий" уровень (фон)
    // Сортируем кэш громкости и берем 10-й перцентиль (самые тихие моменты)
    const sortedRMS = [...cachedRMS].sort((a, b) => a - b);
    const backgroundNoiseRMS = sortedRMS[Math.floor(sortedRMS.length * 0.1)];
    
    // Переводим RMS в dB
    let autoDb = 20 * Math.log10(backgroundNoiseRMS + 0.00001);
    
    // Корректируем: берем чуть выше фонового шума
    autoDb = Math.round(autoDb + 8); 
    
    // Ограничиваем разумными пределами
    if (autoDb < -50) autoDb = -45;
    if (autoDb > -25) autoDb = -30;

    // 2. Длительность пауз
    // Если видео короткое (< 1 мин), делаем резче (0.4с). Если длинное — мягче (0.7с)
    let autoDur = audioDuration > 60 ? 0.6 : 0.4;

    return { db: autoDb, dur: autoDur };
}

// Изменяем drawWaveform, чтобы она учитывала режим
function drawWaveform() {
    if (renderPending || !audioBufferData) return;
    renderPending = true;

    requestAnimationFrame(() => {
        const canvas = document.getElementById("waveform");
        const ctx = canvas.getContext("2d");
        const w = canvas.width = canvas.offsetWidth;
        const h = canvas.height = canvas.offsetHeight;

        ctx.clearRect(0, 0, w, h);
        
        // Рисуем волну (синим)
        const step = Math.ceil(audioBufferData.length / w);
        ctx.fillStyle = "#2b6cff";
        for (let i = 0; i < w; i++) {
            let min = 1, max = -1;
            for (let j = 0; j < step; j++) {
                const val = audioBufferData[(i * step) + j] || 0;
                if (val < min) min = val;
                if (val > max) max = val;
            }
            ctx.fillRect(i, (1 + min) * (h/2), 1, Math.max(1, (max - min) * (h/2)));
        }

        // Параметры для детекции
        let db, dur;
        if (currentMode === 'auto') {
            const auto = getAutoParams();
            db = auto.db;
            dur = auto.dur;
            document.getElementById("autoInfo").innerText = `✨ Авто-режим: Порог ${db}dB, Длительность ${dur}сек`;
        } else {
            db = parseFloat(ui.threshold.value);
            dur = parseFloat(ui.duration.value);
        }

        const silences = detectSilenceFast(db, dur);
        ctx.fillStyle = "rgba(255, 50, 50, 0.4)";
        silences.forEach(s => {
            const x1 = (s.start / audioDuration) * w;
            const x2 = (s.end / audioDuration) * w;
            ctx.fillRect(x1, 0, x2 - x1, h);
        });
        renderPending = false;
    });
}

// В функции ui.processBtn.onclick замените получение параметров на:
let db, dur;
if (currentMode === 'auto') {
    const auto = getAutoParams();
    db = auto.db;
    dur = auto.dur;
} else {
    db = parseFloat(ui.threshold.value);
    dur = parseFloat(ui.duration.value);
}
// ... дальше используйте db и dur в detectSilenceFast(db, dur)

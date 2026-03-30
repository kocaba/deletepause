// Инициализация FFmpeg
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ 
    log: false, 
    corePath: './ffmpeg/ffmpeg-core.js' 
});

// Глобальные переменные состояния
let audioBufferData = null;
let cachedRMS = [];
let audioDuration = 0;
let sampleRate = 44100;
let isLoaded = false;
let wakeLock = null;

// UI Элементы
const ui = {
    duration: document.getElementById("duration"),
    threshold: document.getElementById("threshold"),
    durationVal: document.getElementById("durationVal"),
    thresholdVal: document.getElementById("thresholdVal"),
    processBtn: document.getElementById("processBtn"),
    progCont: document.getElementById("progCont"),
    progressBar: document.getElementById("progressBar"),
    statusText: document.getElementById("statusText"),
    etaText: document.getElementById("etaText"),
    downloadBtn: document.getElementById("downloadBtn"),
    preview: document.getElementById("preview")
};

// Константы анализа
const WINDOW_SIZE = 1024;

// --- Вспомогательные функции ---

async function toggleWakeLock(on) {
    try {
        if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
        else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { console.warn("WakeLock error"); }
}

// Предварительный расчет RMS для мгновенного обновления превью
function precalculateRMS() {
    cachedRMS = [];
    for (let i = 0; i < audioBufferData.length; i += WINDOW_SIZE) {
        let sum = 0;
        for (let j = 0; j < WINDOW_SIZE; j++) {
            const s = audioBufferData[i + j] || 0;
            sum += s * s;
        }
        cachedRMS.push(Math.sqrt(sum / WINDOW_SIZE));
    }
}

// Быстрый поиск пауз по кэшированным данным
function detectSilenceFast(db, minDur) {
    const limit = Math.pow(10, db / 20);
    const silences = [];
    let start = null;
    const secPerBlock = WINDOW_SIZE / sampleRate;

    cachedRMS.forEach((rms, i) => {
        const time = i * secPerBlock;
        if (rms < limit) {
            if (start === null) start = time;
        } else if (start !== null) {
            if (time - start >= minDur) silences.push({ start, end: time });
            start = null;
        }
    });
    return silences;
}

// Отрисовка волны (оптимизирована через requestAnimationFrame)
let renderPending = false;
function drawWaveform() {
    if (renderPending || !audioBufferData) return;
    renderPending = true;

    requestAnimationFrame(() => {
        const canvas = document.getElementById("waveform");
        const ctx = canvas.getContext("2d");
        const w = canvas.width = canvas.offsetWidth;
        const h = canvas.height = canvas.offsetHeight;

        ctx.clearRect(0, 0, w, h);
        
        // Рисуем аудио-волну
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

        // Рисуем красные зоны тишины
        const silences = detectSilenceFast(parseFloat(ui.threshold.value), parseFloat(ui.duration.value));
        ctx.fillStyle = "rgba(255, 50, 50, 0.4)";
        silences.forEach(s => {
            const x1 = (s.start / audioDuration) * w;
            const x2 = (s.end / audioDuration) * w;
            ctx.fillRect(x1, 0, x2 - x1, h);
        });
        renderPending = false;
    });
}

// --- Обработчики событий ---

document.getElementById("fileInput").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    ui.statusText.innerText = "Анализ звука...";
    ui.progCont.style.display = "block";
    
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBtn = await file.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arrayBtn);

    audioBufferData = decoded.getChannelData(0);
    audioDuration = decoded.duration;
    sampleRate = decoded.sampleRate;

    precalculateRMS();
    drawWaveform();
    
    ui.preview.src = URL.createObjectURL(file);
    ui.statusText.innerText = "Готово к обработке";
};

ui.duration.oninput = () => { ui.durationVal.innerText = ui.duration.value + " сек"; drawWaveform(); };
ui.threshold.oninput = () => { ui.thresholdVal.innerText = ui.threshold.value + " dB"; drawWaveform(); };

// --- ГЛАВНЫЙ ПРОЦЕСС ---

let totalOutDur = 0;
let startTime = 0;

ffmpeg.setLogger(({ message }) => {
    const match = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
    if (match && totalOutDur > 0) {
        const time = parseInt(match[1])*3600 + parseInt(match[2])*60 + parseFloat(match[3]);
        const percent = Math.min(100, (time / totalOutDur) * 100);
        
        ui.progressBar.style.width = percent + "%";
        ui.statusText.innerText = `Обработка: ${percent.toFixed(1)}%`;

        const elapsed = (Date.now() - startTime) / 1000;
        const eta = Math.round((totalOutDur - time) / (time / elapsed));
        if (eta > 0) ui.etaText.innerText = `Осталось примерно: ${eta} сек.`;
    }
});

ui.processBtn.onclick = async () => {
    const file = document.getElementById("fileInput").files[0];
    if (!file || !audioBufferData) return alert("Файл не выбран");

    ui.processBtn.disabled = true;
    ui.progCont.style.display = "block";
    
    if (!isLoaded) {
        ui.statusText.innerText = "Загрузка FFmpeg...";
        await ffmpeg.load();
        isLoaded = true;
    }

    await toggleWakeLock(true);

    const silences = detectSilenceFast(parseFloat(ui.threshold.value), parseFloat(ui.duration.value));
    
    // Формируем сегменты (что оставить)
    const segments = [];
    let prev = 0;
    const PAD = 0.1; // Запас 100мс для естественности
    silences.forEach(s => {
        if (s.start > prev) segments.push({ start: Math.max(0, prev - PAD), end: s.start + PAD });
        prev = s.end;
    });
    if (prev < audioDuration) segments.push({ start: prev - PAD, end: audioDuration });

    totalOutDur = segments.reduce((acc, s) => acc + (s.end - s.start), 0);
    
    ui.statusText.innerText = "Подготовка видео...";
    ffmpeg.FS("writeFile", "in.mp4", await fetchFile(file));

    let filter = "";
    let concat = "";
    segments.forEach((s, i) => {
        filter += `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
        filter += `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
        concat += `[v${i}][a${i}]`;
    });
    filter += `${concat}concat=n=${segments.length}:v=1:a=1[ov][oa]`;

    startTime = Date.now();
    await ffmpeg.run("-i", "in.mp4", "-filter_complex", filter, "-map", "[ov]", "-map", "[oa]", 
                     "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-c:a", "aac", "out.mp4");

    const data = ffmpeg.FS("readFile", "out.mp4");
    ffmpeg.FS("unlink", "in.mp4");
    ffmpeg.FS("unlink", "out.mp4");

    const url = URL.createObjectURL(new Blob([data.buffer], { type: "video/mp4" }));
    ui.preview.src = url;
    ui.downloadBtn.href = url;
    ui.downloadBtn.style.display = "block";
    ui.statusText.innerText = "Готово!";
    ui.processBtn.disabled = false;
    await toggleWakeLock(false);
};

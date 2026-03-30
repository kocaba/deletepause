// =========================
// INIT FFMPEG
// =========================
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ log: true });

let loaded = false;
let logs = [];
let currentProgress = 0;
let wakeLock = null;

// =========================
// STATE (Оптимизировано)
// =========================
let audioData = null;
let audioDuration = 0;
let sampleRate = 44100;
let cachedPeaks = []; // Кэш для быстрой отрисовки

// =========================
// STATUS
// =========================
function setStatus(text) {
    document.getElementById("progress").innerText = text;
}

// =========================
// WAKE LOCK
// =========================
async function enableWakeLock() {
    try {
        if ("wakeLock" in navigator) {
            wakeLock = await navigator.wakeLock.request("screen");
        }
    } catch (e) { console.log("WakeLock error", e); }
}

function disableWakeLock() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

// =========================
// LOGGER + PROGRESS
// =========================
ffmpeg.setLogger(({ message }) => {
    const match = message.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
    if (match && audioDuration) {
        const h = +match[1], m = +match[2], s = +match[3];
        const currentTime = h * 3600 + m * 60 + s;
        const percent = Math.min(100, (currentTime / audioDuration) * 100);
        if (percent - currentProgress > 1) {
            currentProgress = percent;
            setStatus(`Обработка: ${percent.toFixed(0)}%`);
        }
    }
});

// =========================
// LOAD FFMPEG
// =========================
async function loadFFmpeg() {
    if (!loaded) {
        setStatus("Загрузка движка...");
        await ffmpeg.load();
        loaded = true;
    }
}

// =========================
// AUDIO ANALYSIS & PEAK CACHING (NEW!)
// =========================
async function loadAudioData(file) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = await file.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(buffer);

    audioData = decoded.getChannelData(0);
    audioDuration = decoded.duration;
    sampleRate = decoded.sampleRate;

    // Генерируем кэш пиков для отрисовки (1 точка на 1 пиксель ширины экрана)
    // Это делается 1 раз и позволяет отрисовывать Waveform мгновенно
    const width = 1000; // фиксированное разрешение для кэша
    cachedPeaks = [];
    const step = Math.ceil(audioData.length / width);
    
    for (let i = 0; i < width; i++) {
        let min = 1.0, max = -1.0;
        for (let j = 0; j < step; j++) {
            const datum = audioData[i * step + j];
            if (datum < min) min = datum;
            if (datum > max) max = datum;
        }
        cachedPeaks.push({ min, max });
    }
}

// =========================
// DETECT SILENCE (Оптимизировано)
// =========================
function detectSilencePCM(thresholdDb, minDuration) {
    const threshold = Math.pow(10, thresholdDb / 20);
    const stepSize = 2048; // Увеличили шаг для скорости анализа
    const silences = [];
    let silenceStart = null;

    for (let i = 0; i < audioData.length; i += stepSize) {
        let sum = 0;
        // Берем небольшое окно для замера громкости
        for (let j = 0; j < 512; j++) {
            const s = audioData[i + j] || 0;
            sum += s * s;
        }
        const rms = Math.sqrt(sum / 512);
        const time = i / sampleRate;

        if (rms < threshold) {
            if (silenceStart === null) silenceStart = time;
        } else {
            if (silenceStart !== null) {
                const dur = time - silenceStart;
                if (dur >= minDuration) silences.push({ start: silenceStart, end: time });
                silenceStart = null;
            }
        }
    }
    return silences;
}

// =========================
// DRAW WAVEFORM (МГНОВЕННАЯ)
// =========================
function drawWaveform() {
    if (!cachedPeaks.length) return;

    const canvas = document.getElementById("waveform");
    const ctx = canvas.getContext("2d");
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    const { width, height } = canvas;
    const amp = height / 2;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#2b6cff"; // Цвет волны

    // Рисуем из кэша (всего 1000 итераций вместо миллионов)
    cachedPeaks.forEach((p, i) => {
        const x = (i / cachedPeaks.length) * width;
        ctx.fillRect(x, (1 + p.min) * amp, 1, Math.max(1, (p.max - p.min) * amp));
    });

    // Рисуем зоны тишины
    const thr = parseFloat(document.getElementById("threshold").value);
    const dur = parseFloat(document.getElementById("duration").value);
    const silences = detectSilencePCM(thr, dur);

    ctx.fillStyle = "rgba(255, 0, 0, 0.4)";
    silences.forEach(s => {
        const x1 = (s.start / audioDuration) * width;
        const x2 = (s.end / audioDuration) * width;
        ctx.fillRect(x1, 0, x2 - x1, height);
    });
}

// =========================
// EVENTS
// =========================
document.getElementById("fileInput").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById("preview").src = URL.createObjectURL(file);
    setStatus("Анализ аудио (это быстро)...");
    await loadAudioData(file);
    drawWaveform();
    setStatus("Готово к обработке");
};

// Мгновенное обновление при движении ползунков
document.getElementById("threshold").oninput = () => {
    document.getElementById("thresholdVal").innerText = document.getElementById("threshold").value + " dB";
    if (audioData) drawWaveform();
};

document.getElementById("duration").oninput = () => {
    document.getElementById("durationVal").innerText = document.getElementById("duration").value + " сек";
    if (audioData) drawWaveform();
};

// =========================
// MAIN PROCESS
// =========================
document.getElementById("processBtn").onclick = async () => {
    const fileInput = document.getElementById("fileInput");
    if (!fileInput.files[0]) return alert("Выбери файл");

    await loadFFmpeg();
    await enableWakeLock();
    currentProgress = 0;
    setStatus("Подготовка фильтров...");

    const thr = parseFloat(document.getElementById("threshold").value);
    const dur = parseFloat(document.getElementById("duration").value);
    const silences = detectSilencePCM(thr, dur);

    if (!silences.length) {
        setStatus("Тишина не найдена");
        disableWakeLock();
        return;
    }

    // Собираем сегменты (то, что ОСТАВЛЯЕМ)
    let segments = [];
    let lastEnd = 0;
    silences.forEach(s => {
        if (s.start > lastEnd) segments.push({ start: lastEnd, end: s.start });
        lastEnd = s.end;
    });
    if (lastEnd < audioDuration) segments.push({ start: lastEnd, end: audioDuration });

    // Оптимизация FFmpeg команд
    ffmpeg.FS("writeFile", "input.mp4", await fetchFile(fileInput.files[0]));

    let filter = "";
    let concatParts = "";
    segments.forEach((s, i) => {
        filter += `[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}];`;
        filter += `[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}];`;
        concatParts += `[v${i}][a${i}]`;
    });
    filter += `${concatParts}concat=n=${segments.length}:v=1:a=1[outv][outa]`;

    setStatus("Рендеринг видео...");

    await ffmpeg.run(
        "-i", "input.mp4",
        "-filter_complex", filter,
        "-map", "[outv]",
        "-map", "[outa]",
        "-preset", "ultrafast", // Максимальная скорость
        "-sn", "-dn",            // Отключаем субтитры и лишние данные (важно для скорости!)
        "-c:v", "libx264",
        "-crf", "28",           // Чуть ниже качество, но выше скорость
        "-c:a", "aac",
        "-b:a", "128k",
        "output.mp4"
    );

    const data = ffmpeg.FS("readFile", "output.mp4");
    const url = URL.createObjectURL(new Blob([data.buffer], { type: "video/mp4" }));
    
    document.getElementById("preview").src = url;
    const dl = document.getElementById("downloadBtn");
    dl.href = url;
    dl.style.display = "block";
    
    setStatus("Готово!");
    disableWakeLock();
};

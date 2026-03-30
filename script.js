// =========================
// INIT FFMPEG
// =========================
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ 
    log: false, // Отключаем логи в консоль для экономии ресурсов, если не отлаживаем
    corePath: './ffmpeg/ffmpeg-core.js' 
});

let loaded = false;
let wakeLock = null;

// =========================
// STATE (Кэширование для скорости)
// =========================
let audioBufferData = null; // Оригинальный Float32Array
let cachedRMS = [];         // Кэшированные значения громкости по блокам
let audioDuration = 0;
let sampleRate = 44100;
const WINDOW_SIZE = 1024;   // Размер окна анализа

// =========================
// UTILS
// =========================
function setStatus(text) {
    document.getElementById("progress").innerText = text;
}

async function enableWakeLock() {
    try {
        if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    } catch (e) { console.warn("WakeLock error:", e); }
}

function disableWakeLock() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

// =========================
// ОПТИМИЗИРОВАННЫЙ АНАЛИЗ
// =========================

// 1. Предварительный расчет RMS (выполняется один раз при загрузке)
function precalculateRMS() {
    cachedRMS = [];
    for (let i = 0; i < audioBufferData.length; i += WINDOW_SIZE) {
        let sum = 0;
        for (let j = 0; j < WINDOW_SIZE; j++) {
            const sample = audioBufferData[i + j] || 0;
            sum += sample * sample;
        }
        cachedRMS.push(Math.sqrt(sum / WINDOW_SIZE));
    }
}

// 2. Быстрый поиск тишины (использует кэш RMS)
function detectSilenceFast(thresholdDb, minDuration) {
    const threshold = Math.pow(10, thresholdDb / 20);
    const silences = [];
    let silenceStart = null;
    
    const secondsPerBlock = WINDOW_SIZE / sampleRate;

    for (let i = 0; i < cachedRMS.length; i++) {
        const rms = cachedRMS[i];
        const time = i * secondsPerBlock;

        if (rms < threshold) {
            if (silenceStart === null) silenceStart = time;
        } else {
            if (silenceStart !== null) {
                const dur = time - silenceStart;
                if (dur >= minDuration) {
                    silences.push({ start: silenceStart, end: time });
                }
                silenceStart = null;
            }
        }
    }
    return silences;
}

// =========================
// DRAW WAVEFORM (ОПТИМИЗИРОВАНО)
// =========================
let isDrawing = false;
function drawWaveform() {
    if (isDrawing) return;
    isDrawing = true;

    requestAnimationFrame(() => {
        const canvas = document.getElementById("waveform");
        const ctx = canvas.getContext("2d");
        const width = canvas.width = canvas.offsetWidth;
        const height = canvas.height = canvas.offsetHeight;

        if (!audioBufferData) { isDrawing = false; return; }

        ctx.clearRect(0, 0, width, height);
        
        // Рисуем волну (упрощенно для скорости)
        const step = Math.ceil(audioBufferData.length / width);
        const amp = height / 2;
        ctx.fillStyle = "#2b6cff";
        
        for (let i = 0; i < width; i++) {
            let min = 1, max = -1;
            for (let j = 0; j < step; j++) {
                const val = audioBufferData[(i * step) + j] || 0;
                if (val < min) min = val;
                if (val > max) max = val;
            }
            ctx.fillRect(i, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
        }

        // Рисуем зоны тишины
        const threshold = parseFloat(document.getElementById("threshold").value);
        const duration = parseFloat(document.getElementById("duration").value);
        const silences = detectSilenceFast(threshold, duration);

        ctx.fillStyle = "rgba(255, 50, 50, 0.4)";
        silences.forEach(s => {
            const x1 = (s.start / audioDuration) * width;
            const x2 = (s.end / audioDuration) * width;
            ctx.fillRect(x1, 0, x2 - x1, height);
        });
        
        isDrawing = false;
    });
}

// =========================
// LOAD FILE
// =========================
document.getElementById("fileInput").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setStatus("Декодирование аудио...");
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await file.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);

    audioBufferData = decoded.getChannelData(0);
    audioDuration = decoded.duration;
    sampleRate = decoded.sampleRate;

    precalculateRMS(); // Кэшируем громкость сразу
    drawWaveform();
    
    document.getElementById("preview").src = URL.createObjectURL(file);
    setStatus("Готово к обработке");
};

// =========================
// BUILD SEGMENTS
// =========================
function buildSegments(silences, fullDuration) {
    const segments = [];
    let prev = 0;
    const PAD = 0.1; // Небольшой запас, чтобы не резать буквы

    silences.forEach(s => {
        if (s.start > prev) {
            segments.push({ 
                start: Math.max(0, prev - (prev === 0 ? 0 : PAD)), 
                end: Math.min(fullDuration, s.start + PAD) 
            });
        }
        prev = s.end;
    });

    if (prev < fullDuration) {
        segments.push({ start: prev - PAD, end: fullDuration });
    }
    return segments;
}

// =========================
// MAIN PROCESS (УСКОРЕННЫЙ)
// =========================
document.getElementById("processBtn").onclick = async () => {
    const file = document.getElementById("fileInput").files[0];
    if (!file || !audioBufferData) return alert("Сначала выберите файл");

    const btn = document.getElementById("processBtn");
    btn.disabled = true;

    if (!loaded) {
        setStatus("Загрузка FFmpeg (один раз)...");
        await ffmpeg.load();
        loaded = true;
    }

    await enableWakeLock();

    const threshold = parseFloat(document.getElementById("threshold").value);
    const duration = parseFloat(document.getElementById("duration").value);
    const silences = detectSilenceFast(threshold, duration);
    const segments = buildSegments(silences, audioDuration);

    if (segments.length === 0) {
        setStatus("Тишина не найдена");
        btn.disabled = false;
        return;
    }

    setStatus(`Подготовка ${segments.length} сегментов...`);
    
    // Записываем файл в VFS
    ffmpeg.FS("writeFile", "input.mp4", await fetchFile(file));

    // Оптимизация: Собираем сложный фильтр
    let filter = "";
    let concatInputs = "";
    segments.forEach((s, i) => {
        filter += `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
        filter += `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
        concatInputs += `[v${i}][a${i}]`;
    });
    filter += `${concatInputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`;

    setStatus("Рендеринг... (используем ultrafast)");

    // Флаги для скорости:
    // -preset ultrafast: самый быстрый способ кодирования
    // -crf 28: баланс между качеством и скоростью (выше число - быстрее и хуже качество)
    // -sn: отключаем субтитры для скорости
    await ffmpeg.run(
        "-i", "input.mp4",
        "-filter_complex", filter,
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28", 
        "-c:a", "aac",
        "-b:a", "128k",
        "-sn",
        "output.mp4"
    );

    const data = ffmpeg.FS("readFile", "output.mp4");
    
    // Очистка памяти VFS FFmpeg (ВАЖНО для мобильных)
    ffmpeg.FS("unlink", "input.mp4");
    ffmpeg.FS("unlink", "output.mp4");

    const url = URL.createObjectURL(new Blob([data.buffer], { type: "video/mp4" }));
    document.getElementById("preview").src = url;
    
    const dl = document.getElementById("downloadBtn");
    dl.href = url;
    dl.style.display = "block";

    setStatus("Готово!");
    btn.disabled = false;
    disableWakeLock();
};

// LIVE UPDATE
document.getElementById("threshold").oninput = drawWaveform;
document.getElementById("duration").oninput = drawWaveform;

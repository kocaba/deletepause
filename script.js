const { createFFmpeg, fetchFile } = FFmpeg;

// Инициализация с логированием
const ffmpeg = createFFmpeg({ log: true });

let loaded = false;
let audioData = null;
let audioDuration = 0;
let sampleRate = 44100;
let wakeLock = null;

// Элементы UI
const elements = {
    fileInput: document.getElementById("fileInput"),
    threshold: document.getElementById("threshold"),
    duration: document.getElementById("duration"),
    progress: document.getElementById("progress"),
    preview: document.getElementById("preview"),
    downloadBtn: document.getElementById("downloadBtn"),
    processBtn: document.getElementById("processBtn")
};

// --- Вспомогательные функции ---

async function enableWakeLock() {
    if ("wakeLock" in navigator) {
        try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
    }
}

function setStatus(text) {
    elements.progress.innerText = text;
}

// Прогресс теперь считается точнее
ffmpeg.setLogger(({ message }) => {
    console.log(message);
    const match = message.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
    if (match && audioDuration) {
        const currentTime = (+match[1] * 3600) + (+match[2] * 60) + (+match[3]);
        const percent = Math.min(100, (currentTime / audioDuration) * 100);
        setStatus(`Обработка: ${percent.toFixed(0)}%`);
    }
});

// --- Основная логика ---

elements.fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    elements.preview.src = URL.createObjectURL(file);
    setStatus("Анализ аудио (это быстро)...");

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await file.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);

    audioData = decoded.getChannelData(0);
    audioDuration = decoded.duration;
    sampleRate = decoded.sampleRate;

    drawWaveform();
    setStatus("Готово к быстрой обработке");
};

function detectSilencePCM(thresholdDb, minDuration) {
    const threshold = Math.pow(10, thresholdDb / 20);
    const windowSize = 2048; // Увеличено для скорости анализа
    const silences = [];
    let silenceStart = null;

    for (let i = 0; i < audioData.length; i += windowSize) {
        let sum = 0;
        for (let j = 0; j < windowSize; j++) {
            const sample = audioData[i + j] || 0;
            sum += sample * sample;
        }
        const rms = Math.sqrt(sum / windowSize);
        const time = i / sampleRate;

        if (rms < threshold) {
            if (silenceStart === null) silenceStart = time;
        } else {
            if (silenceStart !== null) {
                if ((time - silenceStart) >= minDuration) {
                    silences.push({ start: silenceStart, end: time });
                }
                silenceStart = null;
            }
        }
    }
    return silences;
}

function drawWaveform() {
    const canvas = document.getElementById("waveform");
    const ctx = canvas.getContext("2d");
    const width = canvas.width = canvas.offsetWidth;
    const height = canvas.height = canvas.offsetHeight;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#2b6cff";

    const step = Math.ceil(audioData.length / width);
    const amp = height / 2;

    for (let i = 0; i < width; i++) {
        let min = 1, max = -1;
        for (let j = 0; j < step; j++) {
            const val = audioData[(i * step) + j] || 0;
            if (val < min) min = val;
            if (val > max) max = val;
        }
        ctx.fillRect(i, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
    }

    // Подсветка тишины
    const silences = detectSilencePCM(parseFloat(elements.threshold.value), parseFloat(elements.duration.value));
    ctx.fillStyle = "rgba(255, 0, 0, 0.4)";
    silences.forEach(s => {
        const x1 = (s.start / audioDuration) * width;
        const x2 = (s.end / audioDuration) * width;
        ctx.fillRect(x1, 0, x2 - x1, height);
    });
}

// Слушатели ползунков
elements.threshold.oninput = () => { if(audioData) drawWaveform(); };
elements.duration.oninput = () => { if(audioData) drawWaveform(); };

// ГЛАВНЫЙ ПРОЦЕСС
elements.processBtn.onclick = async () => {
    const file = elements.fileInput.files[0];
    if (!file || !audioData) return alert("Сначала выберите файл");

    if (!loaded) {
        setStatus("Загрузка FFmpeg (один раз)...");
        await ffmpeg.load();
        loaded = true;
    }

    await enableWakeLock();
    
    const threshold = parseFloat(elements.threshold.value);
    const minDur = parseFloat(elements.duration.value);
    const silences = detectSilencePCM(threshold, minDur);
    
    // Создаем сегменты "со звуком"
    let lastPos = 0;
    const segments = [];
    const PAD = 0.1; // Небольшой отступ, чтобы не резать слова

    silences.forEach(s => {
        if (s.start - lastPos > 0.1) {
            segments.push({ start: lastPos, end: s.start });
        }
        lastPos = s.end;
    });
    if (audioDuration - lastPos > 0.1) {
        segments.push({ start: lastPos, end: audioDuration });
    }

    setStatus(`Склеиваем ${segments.length} фрагментов...`);

    ffmpeg.FS("writeFile", "input.mp4", await fetchFile(file));

    // ОПТИМИЗИРОВАННЫЙ ФИЛЬТР
    // Чтобы было БЫСТРО, мы принудительно снижаем разрешение до 720p (опционально)
    // и используем пресет ultrafast.
    let filter = "";
    let inputs = "";
    segments.forEach((s, i) => {
        const start = Math.max(0, s.start - PAD).toFixed(3);
        const end = Math.min(audioDuration, s.end + PAD).toFixed(3);
        
        filter += `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}];`;
        filter += `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}];`;
        inputs += `[v${i}][a${i}]`;
    });

    filter += `${inputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`;

    await ffmpeg.run(
        "-i", "input.mp4",
        "-filter_complex", filter,
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "libx264",
        "-preset", "ultrafast", // Максимальная скорость
        "-crf", "28",           // Оптимальный баланс качества/скорости
        "-threads", "4",        // Попытка использовать многопоточность
        "-c:a", "aac",
        "-b:a", "128k",
        "output.mp4"
    );

    const data = ffmpeg.FS("readFile", "output.mp4");
    const url = URL.createObjectURL(new Blob([data.buffer], { type: "video/mp4" }));

    elements.preview.src = url;
    elements.downloadBtn.href = url;
    elements.downloadBtn.style.display = "block";
    setStatus("Готово!");
    if (wakeLock) wakeLock.release();
};

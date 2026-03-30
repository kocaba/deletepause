const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ log: false, corePath: './ffmpeg/ffmpeg-core.js' });

let audioBufferData = null;
let cachedRMS = [];
let audioDuration = 0;
let sampleRate = 44100;
let isFFmpegLoaded = false;
let currentMode = 'auto';

// UI Хендлеры
const el = {
    fileInput: document.getElementById('fileInput'),
    stepUpload: document.getElementById('stepUpload'),
    stepSettings: document.getElementById('stepSettings'),
    stepDone: document.getElementById('stepDone'),
    preview: document.getElementById('preview'),
    overlay: document.getElementById('overlay'),
    overlayBar: document.getElementById('overlayBar'),
    overlayStatus: document.getElementById('overlayStatus'),
    overlayPercent: document.getElementById('overlayPercent'),
    overlayETA: document.getElementById('overlayETA'),
    duration: document.getElementById('duration'),
    threshold: document.getElementById('threshold'),
    waveform: document.getElementById('waveform'),
    processBtn: document.getElementById('processBtn')
};

// Переключение табов
document.getElementById('tabAuto').onclick = () => {
    currentMode = 'auto';
    document.getElementById('tabAuto').classList.add('active');
    document.getElementById('tabManual').classList.remove('active');
    document.getElementById('manualPanel').classList.add('hidden');
    document.getElementById('autoNote').classList.remove('hidden');
    drawWaveform();
};

document.getElementById('tabManual').onclick = () => {
    currentMode = 'manual';
    document.getElementById('tabManual').classList.add('active');
    document.getElementById('tabAuto').classList.remove('active');
    document.getElementById('manualPanel').classList.remove('hidden');
    document.getElementById('autoNote').classList.add('hidden');
    drawWaveform();
};

// Загрузка файла
el.fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    el.stepUpload.classList.add('hidden');
    el.stepSettings.classList.remove('hidden');
    document.getElementById('videoHint').classList.add('hidden');

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await file.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);

    audioBufferData = decoded.getChannelData(0);
    audioDuration = decoded.duration;
    sampleRate = decoded.sampleRate;

    // Предварительный расчет RMS
    cachedRMS = [];
    const win = 1024;
    for (let i = 0; i < audioBufferData.length; i += win) {
        let sum = 0;
        for (let j = 0; j < win; j++) {
            const s = audioBufferData[i + j] || 0;
            sum += s * s;
        }
        cachedRMS.push(Math.sqrt(sum / win));
    }

    el.preview.src = URL.createObjectURL(file);
    drawWaveform();
};

function getParams() {
    if (currentMode === 'manual') return { db: parseFloat(el.threshold.value), dur: parseFloat(el.duration.value) };
    const sorted = [...cachedRMS].sort((a, b) => a - b);
    const noise = sorted[Math.floor(sorted.length * 0.1)] || 0.001;
    let db = Math.round(20 * Math.log10(noise + 1e-6) + 8);
    return { db: Math.max(-45, Math.min(-30, db)), dur: audioDuration > 60 ? 0.6 : 0.4 };
}

function drawWaveform() {
    const canvas = el.waveform;
    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.offsetWidth;
    const h = canvas.height = canvas.offsetHeight;
    const { db, dur } = getParams();

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#2b6cff";
    const step = Math.ceil(audioBufferData.length / w);
    for (let i = 0; i < w; i++) {
        let max = 0;
        for (let j = 0; j < step; j++) {
            const v = Math.abs(audioBufferData[i * step + j] || 0);
            if (v > max) max = v;
        }
        ctx.fillRect(i, h/2 - max*(h/2), 1, max*h);
    }

    const limit = Math.pow(10, db / 20);
    const secPB = 1024 / sampleRate;
    ctx.fillStyle = "rgba(255, 50, 50, 0.4)";
    let start = null;
    cachedRMS.forEach((rms, i) => {
        const t = i * secPB;
        if (rms < limit) { if (start === null) start = t; }
        else if (start !== null) {
            if (t - start >= dur) ctx.fillRect((start/audioDuration)*w, 0, ((t-start)/audioDuration)*w, h);
            start = null;
        }
    });
}

el.duration.oninput = () => { document.getElementById('durV').innerText = el.duration.value; drawWaveform(); };
el.threshold.oninput = () => { document.getElementById('thrV').innerText = el.threshold.value; drawWaveform(); };

// ОБРАБОТКА
el.processBtn.onclick = async () => {
    const file = el.fileInput.files[0];
    el.preview.pause(); // Останавливаем видео
    el.overlay.style.display = 'flex';

    if (!isFFmpegLoaded) {
        el.overlayStatus.innerText = "Загрузка ядра...";
        await ffmpeg.load();
        isFFmpegLoaded = true;
    }

    const { db, dur } = getParams();
    const limit = Math.pow(10, db / 20);
    const secPB = 1024 / sampleRate;
    const segments = [];
    let prev = 0, start = null;

    cachedRMS.forEach((rms, i) => {
        const t = i * secPB;
        if (rms < limit) { if (start === null) start = t; }
        else if (start !== null) {
            if (t - start >= dur) {
                if (start > prev) segments.push({ s: Math.max(0, prev - 0.1), e: start + 0.1 });
                prev = t;
            }
            start = null;
        }
    });
    if (prev < audioDuration) segments.push({ s: prev - 0.1, e: audioDuration });

    const outDur = segments.reduce((a, b) => a + (b.e - b.s), 0);
    el.overlayStatus.innerText = "Рендеринг...";
    
    ffmpeg.FS('writeFile', 'i.mp4', await fetchFile(file));

    let filter = "", concat = "";
    segments.forEach((s, i) => {
        filter += `[0:v]trim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
        filter += `[0:a]atrim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
        concat += `[v${i}][a${i}]`;
    });
    filter += `${concat}concat=n=${segments.length}:v=1:a=1[ov][oa]`;

    let startT = Date.now();
    ffmpeg.setLogger(({ message }) => {
        const match = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (match) {
            const t = parseInt(match[1])*3600 + parseInt(match[2])*60 + parseFloat(match[3]);
            const p = Math.min(100, (t / outDur) * 100);
            el.overlayBar.style.width = p + "%";
            el.overlayPercent.innerText = Math.round(p) + "%";
            const elapsed = (Date.now() - startT) / 1000;
            const eta = Math.round((outDur - t) / (t / elapsed));
            if (eta > 0) el.overlayETA.innerText = `Осталось: ~${eta} сек`;
        }
    });

    // -crf 32 для небольшого снижения качества и ускорения
    await ffmpeg.run("-i", "i.mp4", "-filter_complex", filter, "-map", "[ov]", "-map", "[oa]", 
                     "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32", "-c:a", "aac", "o.mp4");

    const data = ffmpeg.FS('readFile', 'o.mp4');
    ffmpeg.FS('unlink', 'i.mp4'); ffmpeg.FS('unlink', 'o.mp4');

    const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
    el.preview.src = url;
    document.getElementById('downloadBtn').href = url;
    
    el.overlay.style.display = 'none';
    el.stepSettings.classList.add('hidden');
    el.stepDone.classList.remove('hidden');
};

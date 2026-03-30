const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ log: false, corePath: './ffmpeg/ffmpeg-core.js' });

let audioBufferData = null;
let cachedRMS = [];
let audioDuration = 0;
let isLoaded = false;
let mode = 'auto';

// Смена режима
window.setMode = (m) => {
    mode = m;
    document.getElementById('tabAuto').classList.toggle('active', m === 'auto');
    document.getElementById('tabManual').classList.toggle('active', m === 'manual');
    document.getElementById('manualPanel').classList.toggle('hidden', m === 'auto');
    drawWaveform();
};

// Загрузка видео
document.getElementById('fileInput').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // UI изменения
    document.getElementById('appCard').classList.add('expanded');
    document.body.classList.add('file-loaded');
    document.getElementById('stepUpload').classList.add('hidden');
    document.getElementById('stepSettings').classList.remove('hidden');
    document.getElementById('videoSection').classList.remove('hidden');
    
    // Создаем видео-плеер динамически
    document.getElementById('videoSection').innerHTML = `<video id="preview" controls style="width:100%"></video>`;
    const preview = document.getElementById('preview');
    preview.src = URL.createObjectURL(file);

    // Анализ аудио
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await file.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    audioBufferData = decoded.getChannelData(0);
    audioDuration = decoded.duration;

    // Кэшируем RMS
    cachedRMS = [];
    for (let i = 0; i < audioBufferData.length; i += 1024) {
        let sum = 0;
        for (let j = 0; j < 1024; j++) {
            const s = audioBufferData[i + j] || 0;
            sum += s * s;
        }
        cachedRMS.push(Math.sqrt(sum / 1024));
    }
    drawWaveform();
};

function getSettings() {
    if (mode === 'manual') return { 
        db: parseFloat(document.getElementById('threshold').value), 
        dur: parseFloat(document.getElementById('duration').value) 
    };
    // Авто-логика: ищем порог шума
    const sorted = [...cachedRMS].sort((a, b) => a - b);
    const noise = sorted[Math.floor(sorted.length * 0.1)] || 0.001;
    let db = Math.round(20 * Math.log10(noise + 1e-6) + 8);
    return { db: Math.max(-45, Math.min(-30, db)), dur: 0.5 };
}

function drawWaveform() {
    const canvas = document.getElementById('waveform');
    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.offsetWidth;
    const h = canvas.height = canvas.offsetHeight;
    const { db, dur } = getSettings();
    const limit = Math.pow(10, db / 20);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0052ff";
    const step = Math.ceil(audioBufferData.length / w);
    for(let i=0; i<w; i++) {
        let max = 0;
        for(let j=0; j<step; j++) {
            const v = Math.abs(audioBufferData[i*step+j] || 0);
            if(v > max) max = v;
        }
        ctx.fillRect(i, h/2 - max*(h/2), 1, max*h);
    }
    
    // Красные зоны тишины
    ctx.fillStyle = "rgba(255,0,0,0.3)";
    let start = null;
    const secPB = 1024 / 44100;
    cachedRMS.forEach((rms, i) => {
        const t = i * secPB;
        if(rms < limit) { if(start === null) start = t; }
        else if(start !== null) {
            if(t - start >= dur) ctx.fillRect((start/audioDuration)*w, 0, ((t-start)/audioDuration)*w, h);
            start = null;
        }
    });
}

// Главный процесс
document.getElementById('processBtn').onclick = async () => {
    const file = document.getElementById('fileInput').files[0];
    const preview = document.getElementById('preview');
    if(preview) preview.pause();
    
    document.getElementById('overlay').style.display = 'flex';
    
    if (!isLoaded) {
        document.getElementById('status').innerText = "Загрузка ядра...";
        await ffmpeg.load();
        isLoaded = true;
    }

    const { db, dur } = getSettings();
    const limit = Math.pow(10, db / 20);
    const secPB = 1024 / 44100;
    const segments = [];
    let prev = 0, start = null;

    cachedRMS.forEach((rms, i) => {
        const t = i * secPB;
        if(rms < limit) { if(start === null) start = t; }
        else if(start !== null) {
            if(t - start >= dur) {
                if(start > prev) segments.push({ s: Math.max(0, prev - 0.1), e: start + 0.1 });
                prev = t;
            }
            start = null;
        }
    });
    if(prev < audioDuration) segments.push({ s: prev - 0.1, e: audioDuration });

    const totalOut = segments.reduce((a, b) => a + (b.e - b.s), 0);
    ffmpeg.FS('writeFile', 'vin.mp4', await fetchFile(file));

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
        if(match) {
            const t = parseInt(match[1])*3600 + parseInt(match[2])*60 + parseFloat(match[3]);
            const p = Math.min(100, (t / totalOut) * 100);
            document.getElementById('overlayBar').style.width = p + "%";
            document.getElementById('percent').innerText = Math.round(p) + "%";
            const elapsed = (Date.now() - startT) / 1000;
            const eta = Math.round((totalOut - t) / (t / elapsed));
            document.getElementById('eta').innerText = `Осталось: ~${eta}с`;
        }
    });

    await ffmpeg.run("-i", "vin.mp4", "-filter_complex", filter, "-map", "[ov]", "-map", "[oa]", 
                     "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32", "-c:a", "aac", "out.mp4");

    const data = ffmpeg.FS('readFile', 'out.mp4');
    ffmpeg.FS('unlink', 'vin.mp4'); ffmpeg.FS('unlink', 'out.mp4');

    const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
    if(preview) preview.src = url;
    document.getElementById('downloadBtn').href = url;
    
    document.getElementById('overlay').style.display = 'none';
    document.getElementById('stepSettings').classList.add('hidden');
    document.getElementById('stepDone').classList.remove('hidden');
};

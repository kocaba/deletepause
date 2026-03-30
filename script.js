const { createFFmpeg, fetchFile } = FFmpeg;

// Спеціальні налаштування для iPhone (Safari)
const ffmpeg = createFFmpeg({ 
    log: true, 
    corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
    mainName: 'main' 
});

let audioBufferData = null;
let cachedRMS = [];
let audioDuration = 0;
let sampleRate = 44100;
let isLoaded = false;
let currentMode = 'auto';

const ui = {
    fileInput: document.getElementById("fileInput"),
    stepFile: document.getElementById("step_file"),
    stepEdit: document.getElementById("step_editor"),
    stepRes: document.getElementById("step_result"),
    ov: document.getElementById("ov_scr_55"),
    pct: document.getElementById("ov_pct"),
    bar: document.getElementById("p_bar_fill"),
    status: document.getElementById("statusText"),
    processBtn: document.getElementById("processBtn"),
    preview: document.getElementById("preview"),
    downloadBtn: document.getElementById("downloadBtn"),
    threshold: document.getElementById("threshold"),
    duration: document.getElementById("duration"),
    tabAuto: document.getElementById("tabAuto"),
    tabManual: document.getElementById("tabManual"),
    manualControls: document.getElementById("manualControls"),
    autoInfo: document.getElementById("autoInfo")
};

// Таби
ui.tabAuto.onclick = () => {
    currentMode = 'auto';
    ui.tabAuto.classList.add('active_t');
    ui.tabManual.classList.remove('active_t');
    ui.manualControls.style.display = 'none';
    ui.autoInfo.style.display = 'block';
};
ui.tabManual.onclick = () => {
    currentMode = 'manual';
    ui.tabManual.classList.add('active_t');
    ui.tabAuto.classList.remove('active_t');
    ui.manualControls.style.display = 'block';
    ui.autoInfo.style.display = 'none';
};

// Завантаження файлу
ui.fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    ui.ov.style.display = 'flex';
    ui.status.innerText = "Аналіз звуку...";

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    try {
        const arrayBuffer = await file.arrayBuffer();
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        audioBufferData = decoded.getChannelData(0);
        audioDuration = decoded.duration;
        sampleRate = decoded.sampleRate;

        // Кэш гучності
        cachedRMS = [];
        const step = 2048;
        for (let i = 0; i < audioBufferData.length; i += step) {
            let sum = 0;
            for (let j = 0; j < step; j++) {
                const s = audioBufferData[i + j] || 0;
                sum += s * s;
            }
            cachedRMS.push(Math.sqrt(sum / step));
        }

        ui.stepFile.classList.add('hidden_node');
        ui.stepEdit.classList.remove('hidden_node');
        ui.preview.src = URL.createObjectURL(file);
        ui.ov.style.display = 'none';
        drawWaveform();
    } catch (err) {
        alert("Помилка обробки файлу. Спробуйте формат MP4.");
        ui.ov.style.display = 'none';
    }
};

function drawWaveform() {
    const canvas = document.getElementById("waveform");
    const ctx = canvas.getContext("2d");
    const w = canvas.width = canvas.offsetWidth;
    const h = canvas.height = canvas.offsetHeight;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = "#2b6cff";
    const step = Math.ceil(audioBufferData.length / w);
    for (let i = 0; i < w; i++) {
        let min = 1, max = -1;
        for (let j = 0; j < step; j++) {
            const v = audioBufferData[(i * step) + j] || 0;
            if (v < min) min = v; if (v > max) max = v;
        }
        ctx.fillRect(i, (1 + min) * (h/2), 1, Math.max(1, (max - min) * (h/2)));
    }
}

ui.processBtn.onclick = async () => {
    if (!isLoaded) {
        ui.ov.style.display = 'flex';
        ui.status.innerText = "Завантаження ядра...";
        await ffmpeg.load();
        isLoaded = true;
    }

    ui.ov.style.display = 'flex';
    ui.processBtn.disabled = true;

    const db = currentMode === 'auto' ? -35 : parseFloat(ui.threshold.value);
    const dur = currentMode === 'auto' ? 0.5 : parseFloat(ui.duration.value);
    const limit = Math.pow(10, db / 20);
    
    // Пошук пауз
    const silences = [];
    let start = null;
    const secPerBlock = 2048 / sampleRate;
    cachedRMS.forEach((v, i) => {
        const time = i * secPerBlock;
        if (v < limit) { if (start === null) start = time; }
        else if (start !== null) {
            if (time - start >= dur) silences.push({ start, end: time });
            start = null;
        }
    });

    const segments = [];
    let prev = 0;
    silences.forEach(s => {
        if (s.start > prev) segments.push({ s: Math.max(0, prev - 0.1), e: s.start + 0.1 });
        prev = s.end;
    });
    if (prev < audioDuration) segments.push({ s: prev - 0.1, e: audioDuration });

    const totalOut = segments.reduce((a, s) => a + (s.e - s.s), 0);
    ffmpeg.FS("writeFile", "in.mp4", await fetchFile(ui.fileInput.files[0]));

    let filter = ""; let concat = "";
    segments.forEach((s, i) => {
        filter += `[0:v]trim=start=${s.s.toFixed(2)}:end=${s.e.toFixed(2)},setpts=PTS-STARTPTS[v${i}];`;
        filter += `[0:a]atrim=start=${s.s.toFixed(2)}:end=${s.e.toFixed(2)},asetpts=PTS-STARTPTS[a${i}];`;
        concat += `[v${i}][a${i}]`;
    });
    filter += `${concat}concat=n=${segments.length}:v=1:a=1[ov][oa]`;

    ffmpeg.setLogger(({ message }) => {
        const match = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (match) {
            const time = parseInt(match[1])*3600 + parseInt(match[2])*60 + parseFloat(match[3]);
            const p = Math.round((time / totalOut) * 100);
            ui.bar.style.width = p + "%";
            ui.pct.innerText = p + "%";
        }
    });

    await ffmpeg.run("-i", "in.mp4", "-filter_complex", filter, "-map", "[ov]", "-map", "[oa]", "-c:v", "libx264", "-preset", "ultrafast", "out.mp4");

    const data = ffmpeg.FS("readFile", "out.mp4");
    const url = URL.createObjectURL(new Blob([data.buffer], { type: "video/mp4" }));
    ui.preview.src = url;
    ui.downloadBtn.href = url;
    ui.downloadBtn.style.display = "block";
    ui.ov.style.display = 'none';
    ui.stepEdit.classList.add('hidden_node');
    ui.stepRes.classList.remove('hidden_node');
};

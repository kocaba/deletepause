const { createFFmpeg, fetchFile } = FFmpeg;

// Инициализация FFmpeg с логированием для отладки, если нужно
const ffmpeg = createFFmpeg({ log: false }); 

let isLoaded = false;
let audioBuffer = null;
let currentObjectURL = null;

const el = {
    file: document.getElementById('fileInput'),
    dur: document.getElementById('duration'),
    thr: document.getElementById('threshold'),
    durVal: document.getElementById('durVal'),
    thrVal: document.getElementById('thrVal'),
    btn: document.getElementById('processBtn'),
    status: document.getElementById('status'),
    progress: document.getElementById('progressFill'),
    canvas: document.getElementById('waveform'),
    video: document.getElementById('preview'),
    download: document.getElementById('downloadBtn')
};

// Обновление текста ползунков
el.dur.oninput = () => { el.durVal.innerText = el.dur.value + " сек"; updateWaveform(); };
el.thr.oninput = () => { el.thrVal.innerText = el.thr.value + " dB"; updateWaveform(); };

function cleanupMemory() {
    if (currentObjectURL) {
        URL.revokeObjectURL(currentObjectURL);
        currentObjectURL = null;
    }
    try {
        ffmpeg.FS('unlink', 'input.mp4');
        ffmpeg.FS('unlink', 'output.mp4');
    } catch (e) {}
}

el.file.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    cleanupMemory();
    el.status.innerText = "Анализ аудио дорожки...";
    
    const url = URL.createObjectURL(file);
    el.video.src = url;
    currentObjectURL = url;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await file.arrayBuffer();
    
    try {
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        audioBuffer = decoded.getChannelData(0);
        updateWaveform();
        el.status.innerText = "Файл готов к обработке";
    } catch (err) {
        el.status.innerText = "Ошибка декодирования аудио: " + err.message;
    }
};

function updateWaveform() {
    if (!audioBuffer) return;
    const ctx = el.canvas.getContext('2d');
    const w = el.canvas.width = el.canvas.offsetWidth;
    const h = el.canvas.height = 120;
    
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#2b6cff";
    
    const step = Math.ceil(audioBuffer.length / w);
    for (let i = 0; i < w; i++) {
        let max = 0;
        for (let j = 0; j < step; j++) {
            const val = Math.abs(audioBuffer[i * step + j] || 0);
            if (val > max) max = val;
        }
        ctx.fillRect(i, h / 2 - (max * h / 2), 1, max * h);
    }

    const silences = getSilences();
    ctx.fillStyle = "rgba(255, 69, 58, 0.4)";
    silences.forEach(s => {
        const duration = audioBuffer.length / 44100;
        const x1 = (s.start / duration) * w;
        const x2 = (s.end / duration) * w;
        ctx.fillRect(x1, 0, x2 - x1, h);
    });
}

function getSilences() {
    if (!audioBuffer) return [];
    const threshold = Math.pow(10, parseFloat(el.thr.value) / 20);
    const minDur = parseFloat(el.dur.value);
    const sr = 44100;
    const silences = [];
    let start = null;
    
    const step = 2048; 
    for (let i = 0; i < audioBuffer.length; i += step) {
        let sum = 0;
        for (let j = 0; j < step; j++) {
            const val = audioBuffer[i+j] || 0;
            sum += val * val;
        }
        const rms = Math.sqrt(sum / step);
        const time = i / sr;

        if (rms < threshold) {
            if (start === null) start = time;
        } else {
            if (start !== null) {
                if (time - start >= minDur) silences.push({start, end: time});
                start = null;
            }
        }
    }
    return silences;
}

el.btn.onclick = async () => {
    if (!el.file.files[0] || !audioBuffer) return;
    
    el.btn.disabled = true;
    el.status.innerText = "Загрузка FFmpeg...";
    el.progress.style.width = "0%";

    if (!isLoaded) {
        await ffmpeg.load();
        isLoaded = true;
    }

    const duration = audioBuffer.length / 44100;
    const silences = getSilences();
    let last = 0;
    const segments = [];
    
    silences.forEach(s => {
        if (s.start - last > 0.1) segments.push({s: last, e: s.start});
        last = s.end;
    });
    if (duration - last > 0.1) segments.push({s: last, e: duration});

    if (segments.length === 0) {
        el.status.innerText = "Паузы не найдены. Измените настройки.";
        el.btn.disabled = false;
        return;
    }

    el.status.innerText = "Подготовка файлов...";
    ffmpeg.FS('writeFile', 'input.mp4', await fetchFile(el.file.files[0]));

    // Формируем фильтр (Убрали Scale для сохранения качества)
    let filter = "";
    let concat = "";
    segments.forEach((seg, i) => {
        filter += `[0:v]trim=start=${seg.s}:end=${seg.e},setpts=PTS-STARTPTS[v${i}];`;
        filter += `[0:a]atrim=start=${seg.s}:end=${seg.e},asetpts=PTS-STARTPTS[a${i}];`;
        concat += `[v${i}][a${i}]`;
    });
    filter += `${concat}concat=n=${segments.length}:v=1:a=1[outv][outa]`;

    ffmpeg.setProgress(({ ratio }) => {
        el.progress.style.width = (ratio * 100) + "%";
        el.status.innerText = `Обработка качества: ${(ratio * 100).toFixed(0)}%`;
    });

    try {
        await ffmpeg.run(
            '-i', 'input.mp4',
            '-filter_complex', filter,
            '-map', '[outv]', '-map', '[outa]',
            '-c:v', 'libx264', 
            '-preset', 'superfast', // Баланс: быстрее ultrafast по качеству, но не грузит как medium
            '-crf', '23',           // Стандарт высокого качества (было 30)
            '-c:a', 'aac', 
            '-b:a', '128k',         // Хороший звук
            '-movflags', '+faststart',
            'output.mp4'
        );

        const data = ffmpeg.FS('readFile', 'output.mp4');
        const resultUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
        
        el.video.src = resultUrl;
        el.download.href = resultUrl;
        el.download.style.display = "block";
        el.status.innerText = "Готово! Качество сохранено.";
    } catch (err) {
        console.error(err);
        el.status.innerText = "Ошибка памяти. Попробуйте файл поменьше.";
    } finally {
        cleanupMemory();
        el.btn.disabled = false;
    }
};const { createFFmpeg, fetchFile } = FFmpeg;

// Инициализация FFmpeg с логированием для отладки, если нужно
const ffmpeg = createFFmpeg({ log: false }); 

let isLoaded = false;
let audioBuffer = null;
let currentObjectURL = null;

const el = {
    file: document.getElementById('fileInput'),
    dur: document.getElementById('duration'),
    thr: document.getElementById('threshold'),
    durVal: document.getElementById('durVal'),
    thrVal: document.getElementById('thrVal'),
    btn: document.getElementById('processBtn'),
    status: document.getElementById('status'),
    progress: document.getElementById('progressFill'),
    canvas: document.getElementById('waveform'),
    video: document.getElementById('preview'),
    download: document.getElementById('downloadBtn')
};

// Обновление текста ползунков
el.dur.oninput = () => { el.durVal.innerText = el.dur.value + " сек"; updateWaveform(); };
el.thr.oninput = () => { el.thrVal.innerText = el.thr.value + " dB"; updateWaveform(); };

function cleanupMemory() {
    if (currentObjectURL) {
        URL.revokeObjectURL(currentObjectURL);
        currentObjectURL = null;
    }
    try {
        ffmpeg.FS('unlink', 'input.mp4');
        ffmpeg.FS('unlink', 'output.mp4');
    } catch (e) {}
}

el.file.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    cleanupMemory();
    el.status.innerText = "Анализ аудио дорожки...";
    
    const url = URL.createObjectURL(file);
    el.video.src = url;
    currentObjectURL = url;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await file.arrayBuffer();
    
    try {
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        audioBuffer = decoded.getChannelData(0);
        updateWaveform();
        el.status.innerText = "Файл готов к обработке";
    } catch (err) {
        el.status.innerText = "Ошибка декодирования аудио: " + err.message;
    }
};

function updateWaveform() {
    if (!audioBuffer) return;
    const ctx = el.canvas.getContext('2d');
    const w = el.canvas.width = el.canvas.offsetWidth;
    const h = el.canvas.height = 120;
    
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#2b6cff";
    
    const step = Math.ceil(audioBuffer.length / w);
    for (let i = 0; i < w; i++) {
        let max = 0;
        for (let j = 0; j < step; j++) {
            const val = Math.abs(audioBuffer[i * step + j] || 0);
            if (val > max) max = val;
        }
        ctx.fillRect(i, h / 2 - (max * h / 2), 1, max * h);
    }

    const silences = getSilences();
    ctx.fillStyle = "rgba(255, 69, 58, 0.4)";
    silences.forEach(s => {
        const duration = audioBuffer.length / 44100;
        const x1 = (s.start / duration) * w;
        const x2 = (s.end / duration) * w;
        ctx.fillRect(x1, 0, x2 - x1, h);
    });
}

function getSilences() {
    if (!audioBuffer) return [];
    const threshold = Math.pow(10, parseFloat(el.thr.value) / 20);
    const minDur = parseFloat(el.dur.value);
    const sr = 44100;
    const silences = [];
    let start = null;
    
    const step = 2048; 
    for (let i = 0; i < audioBuffer.length; i += step) {
        let sum = 0;
        for (let j = 0; j < step; j++) {
            const val = audioBuffer[i+j] || 0;
            sum += val * val;
        }
        const rms = Math.sqrt(sum / step);
        const time = i / sr;

        if (rms < threshold) {
            if (start === null) start = time;
        } else {
            if (start !== null) {
                if (time - start >= minDur) silences.push({start, end: time});
                start = null;
            }
        }
    }
    return silences;
}

el.btn.onclick = async () => {
    if (!el.file.files[0] || !audioBuffer) return;
    
    el.btn.disabled = true;
    el.status.innerText = "Загрузка FFmpeg...";
    el.progress.style.width = "0%";

    if (!isLoaded) {
        await ffmpeg.load();
        isLoaded = true;
    }

    const duration = audioBuffer.length / 44100;
    const silences = getSilences();
    let last = 0;
    const segments = [];
    
    silences.forEach(s => {
        if (s.start - last > 0.1) segments.push({s: last, e: s.start});
        last = s.end;
    });
    if (duration - last > 0.1) segments.push({s: last, e: duration});

    if (segments.length === 0) {
        el.status.innerText = "Паузы не найдены. Измените настройки.";
        el.btn.disabled = false;
        return;
    }

    el.status.innerText = "Подготовка файлов...";
    ffmpeg.FS('writeFile', 'input.mp4', await fetchFile(el.file.files[0]));

    // Формируем фильтр (Убрали Scale для сохранения качества)
    let filter = "";
    let concat = "";
    segments.forEach((seg, i) => {
        filter += `[0:v]trim=start=${seg.s}:end=${seg.e},setpts=PTS-STARTPTS[v${i}];`;
        filter += `[0:a]atrim=start=${seg.s}:end=${seg.e},asetpts=PTS-STARTPTS[a${i}];`;
        concat += `[v${i}][a${i}]`;
    });
    filter += `${concat}concat=n=${segments.length}:v=1:a=1[outv][outa]`;

    ffmpeg.setProgress(({ ratio }) => {
        el.progress.style.width = (ratio * 100) + "%";
        el.status.innerText = `Обработка качества: ${(ratio * 100).toFixed(0)}%`;
    });

    try {
        await ffmpeg.run(
            '-i', 'input.mp4',
            '-filter_complex', filter,
            '-map', '[outv]', '-map', '[outa]',
            '-c:v', 'libx264', 
            '-preset', 'superfast', // Баланс: быстрее ultrafast по качеству, но не грузит как medium
            '-crf', '13',           // Стандарт высокого качества (было 30)
            '-c:a', 'aac', 
            '-b:a', '128k',         // Хороший звук
            '-movflags', '+faststart',
            'output.mp4'
        );

        const data = ffmpeg.FS('readFile', 'output.mp4');
        const resultUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
        
        el.video.src = resultUrl;
        el.download.href = resultUrl;
        el.download.style.display = "block";
        el.status.innerText = "Готово! Качество сохранено.";
    } catch (err) {
        console.error(err);
        el.status.innerText = "Ошибка памяти. Попробуйте файл поменьше.";
    } finally {
        cleanupMemory();
        el.btn.disabled = false;
    }
};

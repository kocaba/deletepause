const { createFFmpeg, fetchFile } = FFmpeg;

// Инициализация FFmpeg с минимальным логом для экономии ресурсов
const ffmpeg = createFFmpeg({ log: false });

let isLoaded = false;
let audioBuffer = null;
let currentVideoURL = null;
let currentResultURL = null;

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

// Обновление меток ползунков
el.dur.oninput = () => { el.durVal.innerText = el.dur.value + " сек"; updateWaveform(); };
el.thr.oninput = () => { el.thrVal.innerText = el.thr.value + " dB"; updateWaveform(); };

// Функция очистки памяти
function cleanupMemory() {
    if (currentResultURL) URL.revokeObjectURL(currentResultURL);
    try {
        ffmpeg.FS('unlink', 'input.mp4');
        ffmpeg.FS('unlink', 'output.mp4');
    } catch (e) {}
}

// Загрузка и первичный анализ
el.file.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (currentVideoURL) URL.revokeObjectURL(currentVideoURL);
    currentVideoURL = URL.createObjectURL(file);
    el.video.src = currentVideoURL;
    el.download.style.display = "none";

    el.status.innerText = "Анализ аудиодорожки...";
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    try {
        const arrayBuffer = await file.arrayBuffer();
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        audioBuffer = decoded.getChannelData(0);
        updateWaveform();
        el.status.innerText = "Анализ завершен. Можно рендерить.";
    } catch (err) {
        el.status.innerText = "Ошибка чтения аудио. Попробуйте другой файл.";
        console.error(err);
    }
};

// Поиск тишины в PCM данных
function getSilences() {
    if (!audioBuffer) return [];
    const threshold = Math.pow(10, parseFloat(el.thr.value) / 20);
    const minDur = parseFloat(el.dur.value);
    const sampleRate = 44100; // Стандарт для Web Audio API
    const silences = [];
    let start = null;
    
    const step = 2048; 
    for (let i = 0; i < audioBuffer.length; i += step) {
        let sum = 0;
        for (let j = 0; j < step; j++) {
            const val = audioBuffer[i + j] || 0;
            sum += val * val;
        }
        const rms = Math.sqrt(sum / step);
        const time = i / sampleRate;

        if (rms < threshold) {
            if (start === null) start = time;
        } else {
            if (start !== null) {
                if (time - start >= minDur) silences.push({ start, end: time });
                start = null;
            }
        }
    }
    return silences;
}

// Отрисовка Waveform на Canvas
function updateWaveform() {
    if (!audioBuffer) return;
    const ctx = el.canvas.getContext('2d');
    const w = el.canvas.width = el.canvas.offsetWidth;
    const h = el.canvas.height = 140;
    
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#cbd5e0";
    
    const duration = audioBuffer.length / 44100;
    const step = Math.ceil(audioBuffer.length / w);
    
    for (let i = 0; i < w; i++) {
        let max = 0;
        for (let j = 0; j < step; j++) {
            const val = Math.abs(audioBuffer[i * step + j] || 0);
            if (val > max) max = val;
        }
        ctx.fillRect(i, h / 2 - (max * h / 2), 1, max * h);
    }

    // Подсветка вырезаемых зон (красным)
    const silences = getSilences();
    ctx.fillStyle = "rgba(239, 68, 68, 0.4)";
    silences.forEach(s => {
        const x1 = (s.start / duration) * w;
        const x2 = (s.end / duration) * w;
        ctx.fillRect(x1, 0, x2 - x1, h);
    });
}

// ГЛАВНЫЙ ПРОЦЕСС ОБРАБОТКИ
el.btn.onclick = async () => {
    if (!el.file.files[0] || !audioBuffer) return;
    
    el.btn.disabled = true;
    el.status.innerText = "Подготовка FFmpeg...";
    el.progress.style.width = "0%";

    if (!isLoaded) {
        await ffmpeg.load();
        isLoaded = true;
    }

    const totalDur = audioBuffer.length / 44100;
    const silences = getSilences();
    let lastPos = 0;
    const segments = [];
    
    // PAD 0.1s чтобы фразы не обрывались слишком резко
    const PAD = 0.1; 

    silences.forEach(s => {
        if (s.start - lastPos > 0.1) {
            segments.push({
                s: Math.max(0, lastPos - (lastPos === 0 ? 0 : PAD)), 
                e: Math.min(totalDur, s.start + PAD)
            });
        }
        lastPos = s.end;
    });
    if (totalDur - lastPos > 0.1) {
        segments.push({ s: Math.max(0, lastPos - PAD), e: totalDur });
    }

    if (segments.length === 0) {
        alert("Весь ролик распознан как тишина. Измените настройки.");
        el.btn.disabled = false;
        return;
    }

    // Запись файла в виртуальную ФС
    ffmpeg.FS('writeFile', 'input.mp4', await fetchFile(el.file.files[0]));

    // Построение фильтра склейки
    let filter = "";
    let concat = "";
    segments.forEach((seg, i) => {
        // Оставляем оригинальное разрешение (scale=-2:ih)
        filter += `[0:v]trim=start=${seg.s.toFixed(3)}:end=${seg.e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
        filter += `[0:a]atrim=start=${seg.s.toFixed(3)}:end=${seg.e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
        concat += `[v${i}][a${i}]`;
    });
    filter += `${concat}concat=n=${segments.length}:v=1:a=1[outv][outa]`;

    ffmpeg.setProgress(({ ratio }) => {
        el.progress.style.width = (ratio * 100) + "%";
        el.status.innerText = `Рендеринг высокого качества: ${(ratio * 100).toFixed(0)}%`;
    });

    try {
        await ffmpeg.run(
            '-i', 'input.mp4',
            '-filter_complex', filter,
            '-map', '[outv]', '-map', '[outa]',
            '-c:v', 'libx264', 
            '-preset', 'veryfast', 
            '-crf', '20',       // 20 = Высокое качество
            '-pix_fmt', 'yuv420p', 
            '-c:a', 'aac', 
            '-b:a', '192k',     // 192k = Чистый звук
            'output.mp4'
        );

        const data = ffmpeg.FS('readFile', 'output.mp4');
        cleanupMemory();

        currentResultURL = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
        el.video.src = currentResultURL;
        el.download.href = currentResultURL;
        el.download.style.display = "block";
        el.status.innerText = "Готово! Видео сохранено в высоком качестве.";
    } catch (err) {
        console.error(err);
        el.status.innerText = "Ошибка памяти. Попробуйте файл поменьше.";
        cleanupMemory();
    }
    
    el.btn.disabled = false;
};

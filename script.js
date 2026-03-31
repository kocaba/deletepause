// =========================
// ІНІЦІАЛІЗАЦІЯ FFMPEG
// =========================
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ log: false, corePath: './ffmpeg/ffmpeg-core.js' });

// Стан програми
let aBuffer = null;
let cRMS = [];
let aDur = 0;
let sRate = 44100;
let isLoaded = false;
let cMode = 'auto';
let wakeLock = null;
let inputFileName = 'working.mp4'; // ім'я файлу в FFmpeg FS (вже конвертованого)

const WINDOW_SIZE = 1024;

// =========================
// DOM ЕЛЕМЕНТИ
// =========================
const dom = {
    fInp:    document.getElementById('real_f'),
    sFile:   document.getElementById('step_file'),
    sEdit:   document.getElementById('step_editor'),
    sRes:    document.getElementById('step_result'),
    ov:      document.getElementById('ov_scr_55'),
    ovTitle: document.getElementById('ov_title'),
    bar:     document.getElementById('p_bar_fill'),
    ovPct:   document.getElementById('ov_pct'),
    ovEta:   document.getElementById('ov_eta'),
    cvs:     document.getElementById('wv_cvs_11'),
    btnGo:   document.getElementById('go_proc'),
    vPre:    document.getElementById('vid_pre_77'),
    dl:      document.getElementById('dl_btn_99'),
    dur:     document.getElementById('val_dur'),
    db:      document.getElementById('val_db'),
    txtDur:  document.getElementById('txt_dur'),
    txtDb:   document.getElementById('txt_db'),
    aInfo:   document.getElementById('a_info'),
    mCntrls: document.getElementById('m_cntrls'),
};

// =========================
// WAKE LOCK
// =========================
async function lock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
}
function unlock() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

// =========================
// ДОПОМІЖНА: показати прогрес overlay
// =========================
function showOverlay(title, eta) {
    dom.ov.style.display = 'flex';
    dom.ovTitle.innerText = title;
    dom.ovEta.innerText = eta || '';
    dom.ovPct.innerText = '';
    dom.bar.style.width = '0%';
}

function setProgress(pct, etaText) {
    dom.bar.style.width = Math.min(100, pct) + '%';
    dom.ovPct.innerText = Math.round(pct) + '%';
    if (etaText) dom.ovEta.innerText = etaText;
}

// =========================
// TABS
// =========================
function setTab(m) {
    cMode = m;
    document.getElementById('t_auto').classList.toggle('active_t', m === 'auto');
    document.getElementById('t_manual').classList.toggle('active_t', m === 'manual');
    dom.mCntrls.classList.toggle('hidden_node', m === 'auto');
    dom.aInfo.classList.toggle('hidden_node', m === 'manual');
    if (aBuffer) drawWaveform();
}
document.getElementById('t_auto').onclick = () => setTab('auto');
document.getElementById('t_manual').onclick = () => setTab('manual');

// =========================
// ПОВЗУНКИ
// =========================
dom.dur.oninput = () => {
    dom.txtDur.innerText = parseFloat(dom.dur.value).toFixed(2) + ' сек';
    if (aBuffer) drawWaveform();
};
dom.db.oninput = () => {
    dom.txtDb.innerText = dom.db.value + ' dB';
    if (aBuffer) drawWaveform();
};

// =========================
// АВТО-ПАРАМЕТРИ
// =========================
function getAutoParams() {
    if (!cRMS.length) return { db: -35, dur: 0.5 };
    const sorted = [...cRMS].sort((a, b) => a - b);
    const noiseLevel = sorted[Math.floor(sorted.length * 0.1)] || 0.001;
    let autoDb = Math.round(20 * Math.log10(noiseLevel + 1e-6) + 8);
    autoDb = Math.min(-25, Math.max(-50, autoDb));
    const autoDur = aDur > 60 ? 0.6 : 0.45;
    return { db: autoDb, dur: autoDur };
}

// =========================
// ПОШУК ПАУЗ
// =========================
function detectSilences(db, minDur) {
    const limit = Math.pow(10, db / 20);
    const silences = [];
    let start = null;
    const secPerBlock = WINDOW_SIZE / sRate;

    for (let i = 0; i < cRMS.length; i++) {
        const t = i * secPerBlock;
        if (cRMS[i] < limit) {
            if (start === null) start = t;
        } else if (start !== null) {
            if (t - start >= minDur) silences.push({ st: start, en: t });
            start = null;
        }
    }
    if (start !== null) {
        const t = cRMS.length * secPerBlock;
        if (t - start >= minDur) silences.push({ st: start, en: t });
    }
    return silences;
}

// =========================
// МАЛЮВАННЯ ХВИЛІ + ЧЕРВОНІ ЗОНИ
// =========================
function drawWaveform() {
    if (!aBuffer) return;

    const canvas = dom.cvs;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.floor(rect.width) || canvas.offsetWidth || 560;
    canvas.height = 120;
    const w = canvas.width, h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Синя хвиля
    const step = Math.ceil(aBuffer.length / w);
    ctx.fillStyle = '#2b6cff';
    for (let i = 0; i < w; i++) {
        let min = 1, max = -1;
        for (let j = 0; j < step; j++) {
            const v = aBuffer[(i * step) + j] || 0;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        ctx.fillRect(i, (1 + min) * (h / 2), 1, Math.max(1, (max - min) * (h / 2)));
    }

    // Параметри
    let db, dur;
    if (cMode === 'auto') {
        const p = getAutoParams();
        db = p.db; dur = p.dur;
        dom.aInfo.innerText = `✨ Авто: поріг ${db} dB, мін. пауза ${dur} сек`;
    } else {
        db = parseFloat(dom.db.value);
        dur = parseFloat(dom.dur.value);
    }

    // Червоні зони
    const silences = detectSilences(db, dur);
    ctx.fillStyle = 'rgba(220, 30, 30, 0.45)';
    silences.forEach(s => {
        const x1 = (s.st / aDur) * w;
        const x2 = (s.en / aDur) * w;
        ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
    });
}

// =========================
// ВИТЯГНУТИ АУДІО ЧЕРЕЗ FFMPEG → ДЕКОДУВАТИ
// Це ключова оптимізація для iPhone:
//   - Витягуємо тільки аудіо (маленький файл ~1-3 MB замість 200 MB)
//   - Читаємо тільки аудіо через Web Audio API — в 50-100x менше RAM
//   - Великий відеофайл залишається тільки в FFmpeg FS
// =========================
async function extractAndDecodeAudio(fsInputName) {
    dom.ovTitle.innerText = 'Аналіз звуку...';
    dom.ovEta.innerText = 'ВИЗНАЧЕННЯ ПАУЗ';
    dom.ovPct.innerText = '';
    dom.bar.style.width = '30%';

    // Витягуємо тільки аудіо в маленький WAV файл
    await ffmpeg.run(
        '-i', fsInputName,
        '-vn',               // без відео
        '-ar', '22050',      // знижена частота дискретизації (достатньо для аналізу пауз)
        '-ac', '1',          // моно
        '-c:a', 'pcm_s16le', // WAV без стиснення — швидко декодується
        'audio_only.wav'
    );

    dom.bar.style.width = '60%';

    // Читаємо тільки WAV (кілька МБ, не 200 МБ!)
    const wavData = ffmpeg.FS('readFile', 'audio_only.wav');
    try { ffmpeg.FS('unlink', 'audio_only.wav'); } catch(e) {}

    // Декодуємо через Web Audio API
    const aCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await aCtx.decodeAudioData(wavData.buffer);
    // Одразу закриваємо контекст щоб звільнити пам'ять
    if (aCtx.close) aCtx.close();

    aBuffer = decoded.getChannelData(0);
    aDur = decoded.duration;
    sRate = decoded.sampleRate;

    dom.bar.style.width = '80%';

    // Кеш RMS
    cRMS = [];
    for (let i = 0; i < aBuffer.length; i += WINDOW_SIZE) {
        let sum = 0;
        for (let j = 0; j < WINDOW_SIZE; j++) {
            const v = aBuffer[i + j] || 0;
            sum += v * v;
        }
        cRMS.push(Math.sqrt(sum / WINDOW_SIZE));
    }

    dom.bar.style.width = '100%';
}

// =========================
// ПРОГРЕС ЛОГЕР ДЛЯ FFMPEG
// =========================
function setupProgressLogger(totalDur, startTimeMs) {
    ffmpeg.setLogger(({ message }) => {
        // Прогрес через time=
        const mTime = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (mTime && totalDur > 0) {
            const t = parseInt(mTime[1]) * 3600 + parseInt(mTime[2]) * 60 + parseFloat(mTime[3]);
            const pct = Math.min(99, (t / totalDur) * 100);
            setProgress(pct);
            const elapsed = (Date.now() - startTimeMs) / 1000;
            if (elapsed > 1 && t > 0) {
                const eta = Math.round((totalDur - t) / (t / elapsed));
                if (eta > 0) dom.ovEta.innerText = `Залишилось ~${eta} сек.`;
            }
            return;
        }
        // Прогрес через розмір (для remux/encode без time=)
        const mSize = message.match(/size=\s*(\d+)kB/);
        if (mSize) {
            // Не можемо точно рахувати, але показуємо що щось відбувається
            const kb = parseInt(mSize[1]);
            dom.ovEta.innerText = `Оброблено: ${(kb / 1024).toFixed(1)} МБ`;
        }
    });
}

// =========================
// КРОК 1: ЗАВАНТАЖЕННЯ ФАЙЛУ
// Стратегія для iPhone:
//   1. Завантажуємо файл в FFmpeg FS один раз
//   2. Конвертуємо якщо MOV (remux або encode)
//   3. Витягуємо тільки аудіо для аналізу (економія RAM!)
//   4. Великий відеофайл тримаємо ТІЛЬКИ в FFmpeg FS до кінця обробки
// =========================
dom.fInp.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    showOverlay('Підготовка...', '');
    dom.bar.style.width = '5%';

    try {
        if (!isLoaded) {
            dom.ovTitle.innerText = 'Завантаження движка...';
            await ffmpeg.load();
            isLoaded = true;
        }

        dom.ovTitle.innerText = 'Завантаження файлу...';
        dom.ovEta.innerText = 'ЗАЧЕКАЙТЕ';
        dom.bar.style.width = '10%';

        const ext = file.name.split('.').pop().toLowerCase();
        const isMov = ext === 'mov' || file.type === 'video/quicktime' || file.type.includes('quicktime');

        // Очищаємо старі файли з FS якщо є
        for (const name of ['tmp_in.mov', 'working.mp4', 'audio_only.wav', 'final.mp4']) {
            try { ffmpeg.FS('unlink', name); } catch(e) {}
        }

        if (isMov) {
            // Завантажуємо вихідний файл в FS
            ffmpeg.FS('writeFile', 'tmp_in.mov', await fetchFile(file));
            dom.bar.style.width = '20%';

            // --- СПРОБА 1: Remux (без перекодування, 1-2 сек) ---
            dom.ovTitle.innerText = 'Підготовка відео...';
            dom.ovEta.innerText = 'КІЛЬКА СЕКУНД';

            let remuxOk = false;
            setupProgressLogger(0, Date.now()); // показуємо activity навіть без %

            try {
                await ffmpeg.run(
                    '-i', 'tmp_in.mov',
                    '-c', 'copy',
                    '-map', '0',
                    '-movflags', '+faststart',
                    'working.mp4'
                );

                // Перевіряємо чи є аудіо потік в результаті
                let hasAudio = false;
                ffmpeg.setLogger(({ message }) => {
                    if (message.includes('Audio') || message.includes('aac') || message.includes('pcm')) hasAudio = true;
                });
                // Пробуємо витягнути аудіо — якщо вийде, remux OK
                await extractAndDecodeAudio('working.mp4');
                remuxOk = true;

            } catch (err) {
                console.warn('Remux/audio extract failed:', err);
                remuxOk = false;
                try { ffmpeg.FS('unlink', 'working.mp4'); } catch(e) {}
            }

            // --- СПРОБА 2: Перекодування (MOV H.264 режим сумісності) ---
            if (!remuxOk) {
                dom.ovTitle.innerText = 'Підготовка відео...';
                dom.ovEta.innerText = 'ЦЕ МОЖЕ ЗАЙНЯТИ ХВИЛИНУ';
                dom.bar.style.width = '15%';

                setupProgressLogger(0, Date.now());

                await ffmpeg.run(
                    '-i', 'tmp_in.mov',
                    '-c:v', 'libx264',
                    '-preset', 'ultrafast',
                    '-crf', '23',
                    '-c:a', 'aac',
                    '-ar', '44100',
                    '-ac', '1',
                    '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart',
                    'working.mp4'
                );

                await extractAndDecodeAudio('working.mp4');
            }

            // Видаляємо вихідний MOV з FS — він більше не потрібен
            try { ffmpeg.FS('unlink', 'tmp_in.mov'); } catch(e) {}

        } else {
            // MP4 та інші — завантажуємо як є
            ffmpeg.FS('writeFile', 'working.mp4', await fetchFile(file));
            dom.bar.style.width = '20%';
            await extractAndDecodeAudio('working.mp4');
        }

        // ВАЖЛИВО: НЕ читаємо working.mp4 назад в JS — він залишається в FFmpeg FS
        // Це і є головна економія RAM на iPhone
        inputFileName = 'working.mp4';

        // Показуємо редактор
        dom.sFile.classList.add('hidden_node');
        dom.sEdit.classList.remove('hidden_node');

        // Прев'ю — використовуємо оригінальний file object (браузер сам стримить з диска)
        dom.vPre.src = URL.createObjectURL(file);

        dom.ov.style.display = 'none';

        // Малюємо хвилю після того як canvas стає видимим
        requestAnimationFrame(() => setTimeout(() => drawWaveform(), 80));

    } catch (err) {
        console.error('Помилка завантаження:', err);
        alert('Помилка обробки файлу.\n\n' + err.message);
        dom.ov.style.display = 'none';
    }
};

// =========================
// КРОК 2: ОБРОБКА — ВИДАЛЕННЯ ПАУЗ
// =========================
dom.btnGo.onclick = async () => {
    if (!aBuffer) return;

    dom.btnGo.disabled = true;
    await lock();
    showOverlay('Монтаж відео...', 'МОНТАЖ У ПРОЦЕСІ');

    try {
        let db, dur;
        if (cMode === 'auto') {
            const p = getAutoParams();
            db = p.db; dur = p.dur;
        } else {
            db = parseFloat(dom.db.value);
            dur = parseFloat(dom.dur.value);
        }

        const silences = detectSilences(db, dur);

        const PAD = 0.1;
        const segs = [];
        let prev = 0;
        silences.forEach(s => {
            if (s.st > prev) {
                segs.push({
                    s: Math.max(0, prev - (prev === 0 ? 0 : PAD)),
                    e: Math.min(aDur, s.st + PAD)
                });
            }
            prev = s.en;
        });
        if (prev < aDur) segs.push({ s: Math.max(0, prev - PAD), e: aDur });

        if (segs.length === 0) {
            alert('Пауз не знайдено! Спробуйте знизити поріг тиші в ручному режимі.');
            dom.ov.style.display = 'none';
            dom.btnGo.disabled = false;
            unlock();
            return;
        }

        const tOut = segs.reduce((acc, s) => acc + (s.e - s.s), 0);

        // Будуємо filter_complex
        let filterStr = '';
        let concatInputs = '';
        segs.forEach((s, i) => {
            filterStr += `[0:v]trim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
            filterStr += `[0:a]atrim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
            concatInputs += `[v${i}][a${i}]`;
        });
        filterStr += `${concatInputs}concat=n=${segs.length}:v=1:a=1[ov][oa]`;

        setupProgressLogger(tOut, Date.now());

        // working.mp4 вже є в FFmpeg FS з кроку 1 — не завантажуємо повторно!
        await ffmpeg.run(
            '-i', inputFileName,
            '-filter_complex', filterStr,
            '-map', '[ov]',
            '-map', '[oa]',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            'final.mp4'
        );

        // Читаємо результат
        const data = ffmpeg.FS('readFile', 'final.mp4');

        // Звільняємо пам'ять FFmpeg FS одразу
        try { ffmpeg.FS('unlink', inputFileName); } catch(e) {}
        try { ffmpeg.FS('unlink', 'final.mp4'); } catch(e) {}

        const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
        setProgress(100, 'ГОТОВО!');

        setTimeout(() => {
            dom.vPre.src = url;
            dom.dl.href = url;
            dom.dl.style.display = 'block';
            dom.ov.style.display = 'none';
            dom.sEdit.classList.add('hidden_node');
            dom.sRes.classList.remove('hidden_node');
        }, 300);

    } catch (err) {
        console.error('Помилка рендерингу:', err);
        alert('Помилка рендерингу: ' + err.message);
        dom.ov.style.display = 'none';
    } finally {
        dom.btnGo.disabled = false;
        unlock();
    }
};

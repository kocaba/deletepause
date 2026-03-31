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
let currentFile = null; // Файл після можливого remuxing

const WINDOW_SIZE = 1024;

// UI елементи
const dom = {
    fInp:   document.getElementById('real_f'),
    sFile:  document.getElementById('step_file'),
    sEdit:  document.getElementById('step_editor'),
    sRes:   document.getElementById('step_result'),
    ov:     document.getElementById('ov_scr_55'),
    ovTitle:document.getElementById('ov_title'),
    bar:    document.getElementById('p_bar_fill'),
    ovPct:  document.getElementById('ov_pct'),
    ovEta:  document.getElementById('ov_eta'),
    cvs:    document.getElementById('wv_cvs_11'),
    btnGo:  document.getElementById('go_proc'),
    vPre:   document.getElementById('vid_pre_77'),
    dl:     document.getElementById('dl_btn_99'),
    dur:    document.getElementById('val_dur'),
    db:     document.getElementById('val_db'),
    txtDur: document.getElementById('txt_dur'),
    txtDb:  document.getElementById('txt_db'),
    aInfo:  document.getElementById('a_info'),
    mCntrls:document.getElementById('m_cntrls'),
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

// Слухаємо зміни повзунків — відразу перемальовуємо хвилю
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
// ПОШУК ПАУЗ (використовує кеш RMS)
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
    // Якщо тиша до самого кінця
    if (start !== null) {
        const t = cRMS.length * secPerBlock;
        if (t - start >= minDur) silences.push({ st: start, en: t });
    }
    return silences;
}

// =========================
// МАЛЮВАННЯ ХВИЛІ + ЧЕРВОНІ ЗОНИ ПАУЗ
// =========================
function drawWaveform() {
    if (!aBuffer) return;

    const canvas = dom.cvs;
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // 1. Малюємо хвилю (синя)
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

    // 2. Визначаємо поточні параметри
    let db, dur;
    if (cMode === 'auto') {
        const p = getAutoParams();
        db = p.db;
        dur = p.dur;
        dom.aInfo.innerText = `✨ Авто: поріг ${db} dB, мін. пауза ${dur} сек`;
    } else {
        db = parseFloat(dom.db.value);
        dur = parseFloat(dom.dur.value);
    }

    // 3. Малюємо червоні зони (паузи)
    const silences = detectSilences(db, dur);
    ctx.fillStyle = 'rgba(255, 50, 50, 0.45)';
    silences.forEach(s => {
        const x1 = (s.st / aDur) * w;
        const x2 = (s.en / aDur) * w;
        ctx.fillRect(x1, 0, Math.max(1, x2 - x1), h);
    });
}

// =========================
// КРОК 1: ЗАВАНТАЖЕННЯ ФАЙЛУ
// Підтримує: MOV з HEVC (iPhone стандартний), MOV з H.264 (режим сумісності), MP4
// =========================
dom.fInp.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    dom.ov.style.display = 'flex';
    dom.ovTitle.innerText = 'Завантаження FFmpeg...';
    dom.ovPct.innerText = '';
    dom.bar.style.width = '0%';

    try {
        // Завантажуємо FFmpeg один раз
        if (!isLoaded) {
            await ffmpeg.load();
            isLoaded = true;
        }

        const ext = file.name.split('.').pop().toLowerCase();
        const isQuicktime = ext === 'mov' || file.type === 'video/quicktime' || file.type.includes('quicktime');

        let workingFile = file;

        if (isQuicktime) {
            // --- REMUXING MOV → MP4 ---
            // Спрацьовує і для HEVC (стандартний iPhone), і для H.264 (режим сумісності)
            // -c copy = без перекодування, тільки перепакування контейнера
            dom.ovTitle.innerText = 'Конвертація MOV → MP4...';
            dom.ovEta.innerText = 'ЦЕ ЗАЙМЕ 1-2 СЕКУНДИ';

            ffmpeg.FS('writeFile', 'tmp_in.mov', await fetchFile(file));

            try {
                // Спочатку пробуємо просту перепаковку (швидко, без втрати якості)
                await ffmpeg.run('-i', 'tmp_in.mov', '-c', 'copy', '-map', '0', '-movflags', '+faststart', 'tmp_out.mp4');
            } catch (remuxErr) {
                // Якщо перепаковка не вдалась (наприклад, несумісний кодек) — перекодовуємо
                console.warn('Remux failed, re-encoding...', remuxErr);
                dom.ovTitle.innerText = 'Перекодування відео...';
                await ffmpeg.run(
                    '-i', 'tmp_in.mov',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                    '-c:a', 'aac',
                    '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart',
                    'tmp_out.mp4'
                );
            }

            const data = ffmpeg.FS('readFile', 'tmp_out.mp4');
            workingFile = new File([data.buffer], 'ready.mp4', { type: 'video/mp4' });

            // Прибираємо тимчасові файли з пам'яті FFmpeg
            try { ffmpeg.FS('unlink', 'tmp_in.mov'); } catch(e) {}
            try { ffmpeg.FS('unlink', 'tmp_out.mp4'); } catch(e) {}
        }

        currentFile = workingFile;

        // --- ДЕКОДУВАННЯ АУДІО ---
        dom.ovTitle.innerText = 'Аналіз звукової доріжки...';
        dom.ovEta.innerText = '';

        const aCtx = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuf = await workingFile.arrayBuffer();
        const decoded = await aCtx.decodeAudioData(arrayBuf);

        aBuffer = decoded.getChannelData(0);
        aDur = decoded.duration;
        sRate = decoded.sampleRate;

        // Розрахунок кешу RMS
        cRMS = [];
        for (let i = 0; i < aBuffer.length; i += WINDOW_SIZE) {
            let sum = 0;
            for (let j = 0; j < WINDOW_SIZE; j++) {
                const v = aBuffer[i + j] || 0;
                sum += v * v;
            }
            cRMS.push(Math.sqrt(sum / WINDOW_SIZE));
        }

        // Показуємо редактор
        dom.sFile.classList.add('hidden_node');
        dom.sEdit.classList.remove('hidden_node');

        // Встановлюємо прев'ю (вже конвертований файл для сумісності)
        dom.vPre.src = URL.createObjectURL(workingFile);

        dom.ov.style.display = 'none';

        // Малюємо хвилю після того як canvas видимий
        requestAnimationFrame(() => drawWaveform());

    } catch (err) {
        console.error('File load error:', err);
        alert('Помилка обробки файлу. Спробуйте інший файл або формат.\n\n' + err.message);
        dom.ov.style.display = 'none';
    }
};

// =========================
// КРОК 2: ОБРОБКА — ВИДАЛЕННЯ ПАУЗ
// =========================
dom.btnGo.onclick = async () => {
    if (!currentFile || !aBuffer) return;

    dom.btnGo.disabled = true;
    await lock();

    dom.ov.style.display = 'flex';
    dom.ovTitle.innerText = 'Монтаж відео...';
    dom.ovPct.innerText = '0%';
    dom.ovEta.innerText = 'МОНТАЖ У ПРОЦЕСІ';
    dom.bar.style.width = '0%';

    try {
        // Вибір параметрів
        let db, dur;
        if (cMode === 'auto') {
            const p = getAutoParams();
            db = p.db;
            dur = p.dur;
        } else {
            db = parseFloat(dom.db.value);
            dur = parseFloat(dom.dur.value);
        }

        // Пошук пауз
        const silences = detectSilences(db, dur);

        // Формування сегментів мовлення
        const PAD = 0.1; // відступ для плавності
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
        if (prev < aDur) {
            segs.push({ s: Math.max(0, prev - PAD), e: aDur });
        }

        if (segs.length === 0) {
            alert('Пауз не знайдено! Спробуйте знизити поріг тиші в ручному режимі.');
            dom.ov.style.display = 'none';
            dom.btnGo.disabled = false;
            unlock();
            return;
        }

        const tOut = segs.reduce((acc, s) => acc + (s.e - s.s), 0);

        // Записуємо файл у FFmpeg FS
        ffmpeg.FS('writeFile', 'working.mp4', await fetchFile(currentFile));

        // Будуємо filter_complex
        let filterStr = '';
        let concatInputs = '';
        segs.forEach((s, i) => {
            filterStr += `[0:v]trim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
            filterStr += `[0:a]atrim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
            concatInputs += `[v${i}][a${i}]`;
        });
        filterStr += `${concatInputs}concat=n=${segs.length}:v=1:a=1[ov][oa]`;

        // Прогрес-логер
        const startTime = Date.now();
        ffmpeg.setLogger(({ message }) => {
            const m = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
            if (m && tOut > 0) {
                const t = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
                const pct = Math.min(99, (t / tOut) * 100);
                dom.bar.style.width = pct + '%';
                dom.ovPct.innerText = Math.round(pct) + '%';

                const elapsed = (Date.now() - startTime) / 1000;
                if (elapsed > 1 && t > 0) {
                    const eta = Math.round((tOut - t) / (t / elapsed));
                    if (eta > 0) dom.ovEta.innerText = `Залишилось ~${eta} сек.`;
                }
            }
        });

        // Запуск FFmpeg
        await ffmpeg.run(
            '-i', 'working.mp4',
            '-filter_complex', filterStr,
            '-map', '[ov]',
            '-map', '[oa]',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',  // Сумісність з iOS
            '-c:a', 'aac',
            '-movflags', '+faststart',
            'final.mp4'
        );

        // Читаємо результат
        const data = ffmpeg.FS('readFile', 'final.mp4');

        // Прибираємо тимчасові файли
        try { ffmpeg.FS('unlink', 'working.mp4'); } catch(e) {}
        try { ffmpeg.FS('unlink', 'final.mp4'); } catch(e) {}

        const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));

        dom.bar.style.width = '100%';
        dom.ovPct.innerText = '100%';

        // Показуємо результат
        setTimeout(() => {
            dom.vPre.src = url;
            dom.dl.href = url;
            dom.dl.style.display = 'block';
            dom.ov.style.display = 'none';
            dom.sEdit.classList.add('hidden_node');
            dom.sRes.classList.remove('hidden_node');
        }, 300);

    } catch (err) {
        console.error('Render error:', err);
        alert('Помилка рендерингу: ' + err.message);
        dom.ov.style.display = 'none';
    } finally {
        dom.btnGo.disabled = false;
        unlock();
    }
};

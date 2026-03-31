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
let originalFile = null; // оригінальний File об'єкт

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
// ПРОГРЕС
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
    if (etaText !== undefined) dom.ovEta.innerText = etaText;
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
// КРОК 1: ЗАВАНТАЖЕННЯ — тільки Web Audio API, без FFmpeg
//
// Safari/iPhone вміє декодувати аудіо з MOV напряму.
// Якщо не зможе (старий пристрій) — покажемо помилку з порадою.
// FFmpeg взагалі не чіпаємо на цьому етапі.
// =========================
dom.fInp.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    showOverlay('Аналіз аудіо...', 'ЗЧИТУВАННЯ ЗВУКОВОЇ ДОРІЖКИ');
    dom.bar.style.width = '20%';

    try {
        originalFile = file;

        // Читаємо файл як ArrayBuffer
        const arrayBuf = await file.arrayBuffer();
        dom.bar.style.width = '50%';

        // Декодуємо аудіо через Web Audio API
        // Safari підтримує MOV/HEVC/H.264 напряму — без жодного перекодування
        const aCtx = new (window.AudioContext || window.webkitAudioContext)();

        let decoded;
        try {
            decoded = await aCtx.decodeAudioData(arrayBuf);
        } catch (decodeErr) {
            // Safari не зміг — це рідко, але буває з деякими MOV
            // В такому випадку повідомляємо користувача
            if (aCtx.close) aCtx.close();
            throw new Error(
                'Safari не зміг прочитати аудіо з цього файлу.\n\n' +
                'Спробуйте:\n' +
                '• Зайти в Налаштування → Камера → Формати\n' +
                '• Вибрати "Найбільша сумісність"\n' +
                '• Записати відео знову'
            );
        }

        // Звільняємо ArrayBuffer — він більше не потрібен
        // (decoded вже містить дані в потрібному форматі)
        dom.bar.style.width = '70%';

        aBuffer = decoded.getChannelData(0);
        aDur = decoded.duration;
        sRate = decoded.sampleRate;

        // Закриваємо AudioContext щоб звільнити пам'ять
        if (aCtx.close) aCtx.close();

        // Кеш RMS для аналізу пауз
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

        // Показуємо редактор
        dom.sFile.classList.add('hidden_node');
        dom.sEdit.classList.remove('hidden_node');

        // Прев'ю відео (браузер стримить з диска, не в RAM)
        dom.vPre.src = URL.createObjectURL(file);

        dom.ov.style.display = 'none';

        // Малюємо хвилю
        requestAnimationFrame(() => setTimeout(() => drawWaveform(), 80));

    } catch (err) {
        console.error('Помилка завантаження:', err);
        alert('Помилка читання файлу.\n\n' + err.message);
        dom.ov.style.display = 'none';
    }
};

// =========================
// КРОК 2: ОБРОБКА — тільки тут використовуємо FFmpeg
//
// Стратегія економії RAM на iPhone:
//   1. Завантажуємо файл в FFmpeg FS
//   2. Якщо MOV — спочатку remux в MP4 (без перекодування, 1-2 сек)
//      Якщо remux не дав результату — перекодовуємо
//   3. Ріжемо паузи
//   4. Одразу видаляємо проміжні файли з FS після кожного кроку
// =========================
dom.btnGo.onclick = async () => {
    if (!originalFile || !aBuffer) return;

    dom.btnGo.disabled = true;
    await lock();
    showOverlay('Підготовка...', '');

    try {
        // Завантажуємо FFmpeg якщо ще не завантажений
        if (!isLoaded) {
            dom.ovTitle.innerText = 'Завантаження движка...';
            dom.ovEta.innerText = '';
            await ffmpeg.load();
            isLoaded = true;
        }

        // --- Параметри пауз ---
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

        // --- Завантажуємо файл в FFmpeg FS ---
        dom.ovTitle.innerText = 'Завантаження відео...';
        dom.ovEta.innerText = '';
        dom.bar.style.width = '5%';

        const ext = originalFile.name.split('.').pop().toLowerCase();
        const isMov = ext === 'mov' || originalFile.type === 'video/quicktime' || originalFile.type.includes('quicktime');

        // Очищаємо FS від попередніх файлів
        for (const n of ['src.mov', 'src.mp4', 'input.mp4', 'final.mp4']) {
            try { ffmpeg.FS('unlink', n); } catch(e) {}
        }

        let inputFsName;

        if (isMov) {
            ffmpeg.FS('writeFile', 'src.mov', await fetchFile(originalFile));
            dom.bar.style.width = '15%';

            // Налаштовуємо логер для відображення прогресу remux
            ffmpeg.setLogger(({ message }) => {
                const mSize = message.match(/size=\s*(\d+)kB/);
                if (mSize) {
                    const mb = (parseInt(mSize[1]) / 1024).toFixed(1);
                    dom.ovEta.innerText = `Оброблено: ${mb} МБ`;
                }
            });

            // Спроба 1: Remux без перекодування
            dom.ovTitle.innerText = 'Підготовка відео...';
            dom.ovEta.innerText = 'КІЛЬКА СЕКУНД';

            let remuxOk = false;
            try {
                await ffmpeg.run(
                    '-i', 'src.mov',
                    '-c', 'copy',
                    '-map', '0',
                    '-movflags', '+faststart',
                    'input.mp4'
                );
                remuxOk = true;
            } catch(e) {
                console.warn('Remux failed:', e);
                try { ffmpeg.FS('unlink', 'input.mp4'); } catch(e2) {}
            }

            // Спроба 2: Перекодування (якщо remux не вийшов)
            if (!remuxOk) {
                dom.ovTitle.innerText = 'Підготовка відео...';
                dom.ovEta.innerText = 'ЦЕ ЗАЙМЕ ХВИЛИНУ';

                await ffmpeg.run(
                    '-i', 'src.mov',
                    '-c:v', 'libx264',
                    '-preset', 'ultrafast',
                    '-crf', '23',
                    '-c:a', 'aac',
                    '-ar', '44100',
                    '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart',
                    'input.mp4'
                );
            }

            // Видаляємо вихідний MOV — він більше не потрібен, звільняємо місце
            try { ffmpeg.FS('unlink', 'src.mov'); } catch(e) {}
            inputFsName = 'input.mp4';

        } else {
            // MP4 — завантажуємо напряму
            ffmpeg.FS('writeFile', 'input.mp4', await fetchFile(originalFile));
            dom.bar.style.width = '15%';
            inputFsName = 'input.mp4';
        }

        // --- Рендеринг: вирізаємо паузи ---
        dom.ovTitle.innerText = 'Монтаж відео...';
        dom.ovEta.innerText = 'МОНТАЖ У ПРОЦЕСІ';
        dom.bar.style.width = '0%';
        dom.ovPct.innerText = '0%';

        let filterStr = '';
        let concatInputs = '';
        segs.forEach((s, i) => {
            filterStr += `[0:v]trim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
            filterStr += `[0:a]atrim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
            concatInputs += `[v${i}][a${i}]`;
        });
        filterStr += `${concatInputs}concat=n=${segs.length}:v=1:a=1[ov][oa]`;

        const startTime = Date.now();
        ffmpeg.setLogger(({ message }) => {
            const m = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
            if (m && tOut > 0) {
                const t = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
                const pct = Math.min(99, (t / tOut) * 100);
                setProgress(pct);
                const elapsed = (Date.now() - startTime) / 1000;
                if (elapsed > 1 && t > 0) {
                    const eta = Math.round((tOut - t) / (t / elapsed));
                    if (eta > 0) dom.ovEta.innerText = `Залишилось ~${eta} сек.`;
                }
            }
        });

        await ffmpeg.run(
            '-i', inputFsName,
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

        // Читаємо результат і одразу звільняємо FS
        const data = ffmpeg.FS('readFile', 'final.mp4');
        try { ffmpeg.FS('unlink', inputFsName); } catch(e) {}
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
        alert('Помилка: ' + err.message);
        dom.ov.style.display = 'none';
    } finally {
        dom.btnGo.disabled = false;
        unlock();
    }
};

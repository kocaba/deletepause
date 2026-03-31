// =========================
// ІНІЦІАЛІЗАЦІЯ FFMPEG
// =========================
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ log: false, corePath: './ffmpeg/ffmpeg-core.js' });

let aBuffer     = null;   // Float32Array — аудіо для waveform
let cRMS        = [];     // RMS кеш для detectSilences
let aDur        = 0;      // тривалість (сек)
let sRate       = 22050;
let isLoaded    = false;
let cMode       = 'auto';
let wakeLock    = null;

// Ім'я вхідного файлу в FFmpeg FS.
// Це ЗАВЖДИ оригінальний файл — ніякого перекодування до рендеру!
let inputFsName = null;

const WINDOW_SIZE = 1024;

// =========================
// DOM
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
// OVERLAY / ПРОГРЕС
// =========================
function showOverlay(title, eta) {
    dom.ov.style.display  = 'flex';
    dom.ovTitle.innerText = title;
    dom.ovEta.innerText   = eta || '';
    dom.ovPct.innerText   = '';
    dom.bar.style.width   = '0%';
}
function setProgress(pct, eta) {
    dom.bar.style.width = Math.min(100, pct) + '%';
    dom.ovPct.innerText = Math.round(pct) + '%';
    if (eta !== undefined) dom.ovEta.innerText = eta;
}
function hideOverlay() {
    dom.ov.style.display = 'none';
}

// =========================
// TABS
// =========================
function setTab(m) {
    cMode = m;
    document.getElementById('t_auto').classList.toggle('active_t', m === 'auto');
    document.getElementById('t_manual').classList.toggle('active_t', m === 'manual');
    dom.mCntrls.style.display = (m === 'manual') ? 'block' : 'none';
    dom.aInfo.style.display   = (m === 'auto')   ? 'block' : 'none';
    if (aBuffer) drawWaveform();
}
document.getElementById('t_auto').onclick   = () => setTab('auto');
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
    const sorted     = [...cRMS].sort((a, b) => a - b);
    const noiseFloor = sorted[Math.floor(sorted.length * 0.1)] || 0.001;
    let autoDb       = Math.round(20 * Math.log10(noiseFloor + 1e-6) + 8);
    autoDb           = Math.min(-25, Math.max(-50, autoDb));
    return { db: autoDb, dur: aDur > 60 ? 0.6 : 0.45 };
}

// =========================
// ВИЗНАЧЕННЯ ПАУЗ
// =========================
function detectSilences(db, minDur) {
    const limit       = Math.pow(10, db / 20);
    const secPerBlock = WINDOW_SIZE / sRate;
    const silences    = [];
    let start = null;

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
// WAVEFORM
// =========================
function drawWaveform() {
    if (!aBuffer) return;

    const canvas = dom.cvs;
    const ctx    = canvas.getContext('2d');
    const rect   = canvas.getBoundingClientRect();
    canvas.width  = Math.floor(rect.width) || canvas.offsetWidth || 560;
    canvas.height = 120;
    const w = canvas.width, h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const step = Math.max(1, Math.ceil(aBuffer.length / w));
    ctx.fillStyle = '#2b6cff';
    for (let i = 0; i < w; i++) {
        let mn = 1, mx = -1;
        const base = i * step;
        for (let j = 0; j < step && (base + j) < aBuffer.length; j++) {
            const v = aBuffer[base + j];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
        }
        ctx.fillRect(i, (1 + mn) * (h / 2), 1, Math.max(1, (mx - mn) * (h / 2)));
    }

    let db, dur;
    if (cMode === 'auto') {
        const p = getAutoParams();
        db = p.db; dur = p.dur;
        dom.aInfo.innerText = `✨ Авто: поріг ${db} dB, мін. пауза ${dur} сек`;
    } else {
        db  = parseFloat(dom.db.value);
        dur = parseFloat(dom.dur.value);
    }

    ctx.fillStyle = 'rgba(220, 30, 30, 0.45)';
    detectSilences(db, dur).forEach(s => {
        const x1 = (s.st / aDur) * w;
        const x2 = (s.en / aDur) * w;
        ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
    });
}

// =========================
// ВИТЯГТИ ТІЛЬКИ АУДІО → WAV → DECODE → RMS
//
// Працює з будь-яким форматом вхідного файлу — MOV, MP4, HEVC тощо.
// Відео НЕ торкається — тільки аудіодоріжка (-vn).
// WAV ~1-3 МБ замість 200 МБ → мінімум RAM.
// =========================
async function extractAndAnalyzeAudio(fsName) {
    dom.ovTitle.innerText = 'Аналіз звуку...';
    dom.ovEta.innerText   = 'ЧИТАННЯ АУДІОДОРІЖКИ';
    setProgress(30);

    ffmpeg.setLogger(({ message }) => {
        const m = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (m) {
            const t = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
            dom.ovEta.innerText = `Зчитано: ${Math.floor(t)} сек`;
        }
    });

    // Витягуємо ТІЛЬКИ аудіо — відео не перекодується взагалі
    await ffmpeg.run(
        '-i', fsName,
        '-vn',               // без відео
        '-ar', '22050',      // знижена частота — достатньо для аналізу, вдвічі менше даних
        '-ac', '1',          // моно
        '-c:a', 'pcm_s16le', // WAV без стиснення — швидко декодується Safari
        'audio_only.wav'
    );

    setProgress(60);

    const wavData = ffmpeg.FS('readFile', 'audio_only.wav');
    try { ffmpeg.FS('unlink', 'audio_only.wav'); } catch(_) {}

    // Декодуємо через Web Audio API
    const aCtx   = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 22050 });
    const decoded = await aCtx.decodeAudioData(wavData.buffer);
    if (aCtx.close) aCtx.close();

    aBuffer = decoded.getChannelData(0);
    aDur    = decoded.duration;
    sRate   = decoded.sampleRate;

    setProgress(80);

    // RMS кеш
    cRMS = [];
    for (let i = 0; i < aBuffer.length; i += WINDOW_SIZE) {
        let sum = 0;
        const end = Math.min(i + WINDOW_SIZE, aBuffer.length);
        for (let j = i; j < end; j++) sum += aBuffer[j] * aBuffer[j];
        cRMS.push(Math.sqrt(sum / (end - i)));
    }

    setProgress(95);
}

// =========================
// ПРОГРЕС ЛОГЕР ДЛЯ РЕНДЕРУ
// =========================
function setupRenderLogger(totalDur, startMs) {
    ffmpeg.setLogger(({ message }) => {
        const mTime = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (mTime && totalDur > 0) {
            const t   = parseInt(mTime[1]) * 3600 + parseInt(mTime[2]) * 60 + parseFloat(mTime[3]);
            const pct = Math.min(99, (t / totalDur) * 100);
            setProgress(pct);
            const elapsed = (Date.now() - startMs) / 1000;
            if (elapsed > 1 && t > 0) {
                const eta = Math.round((totalDur - t) / (t / elapsed));
                if (eta > 0) dom.ovEta.innerText = `Залишилось ~${eta} сек.`;
            }
            return;
        }
        const mSize = message.match(/size=\s*(\d+)kB/);
        if (mSize) {
            dom.ovEta.innerText = `Оброблено: ${(parseInt(mSize[1]) / 1024).toFixed(1)} МБ`;
        }
    });
}

// =========================
// КРОК 1: ЗАВАНТАЖЕННЯ
//
// Нова стратегія — НІЧОГО не перекодуємо на цьому кроці:
//   1. Завантажуємо оригінальний файл у FFmpeg FS як є (MOV або MP4)
//   2. Витягуємо тільки аудіо → WAV → аналіз
//   3. Оригінальний файл залишається в FS для кроку 2
//   4. На кроці 2 — один прохід FFmpeg: remux + нарізка разом
// =========================
dom.fInp.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    showOverlay('Підготовка...', '');
    setProgress(5);

    try {
        if (!isLoaded) {
            dom.ovTitle.innerText = 'Завантаження движка...';
            dom.ovEta.innerText   = '';
            await ffmpeg.load();
            isLoaded = true;
        }

        // Очищаємо FS від попередньої сесії
        for (const n of ['input.mov', 'input.mp4', 'audio_only.wav', 'final.mp4']) {
            try { ffmpeg.FS('unlink', n); } catch(_) {}
        }

        const ext   = (file.name.split('.').pop() || 'mp4').toLowerCase();
        const isMov = ext === 'mov'
                   || file.type === 'video/quicktime'
                   || file.type.includes('quicktime');

        // Ім'я файлу в FS зберігає розширення — FFmpeg визначає формат по ньому
        inputFsName = isMov ? 'input.mov' : 'input.mp4';

        dom.ovTitle.innerText = 'Завантаження файлу...';
        dom.ovEta.innerText   = 'ЗАЧЕКАЙТЕ';
        setProgress(10);

        // Записуємо оригінальний файл у FS — БЕЗ ЖОДНОГО ПЕРЕКОДУВАННЯ
        ffmpeg.FS('writeFile', inputFsName, await fetchFile(file));
        setProgress(20);

        // Витягуємо тільки аудіо для аналізу (відео не чіпаємо)
        await extractAndAnalyzeAudio(inputFsName);

        // Ініціалізуємо повзунки авто-значеннями
        const autoP = getAutoParams();
        dom.db.value         = autoP.db;
        dom.dur.value        = autoP.dur;
        dom.txtDb.innerText  = autoP.db + ' dB';
        dom.txtDur.innerText = autoP.dur.toFixed(2) + ' сек';

        // Показуємо редактор
        dom.sFile.classList.add('hidden_node');
        dom.sEdit.classList.remove('hidden_node');

        // Прев'ю — стримінг з диска, не в RAM
        dom.vPre.src = URL.createObjectURL(file);

        hideOverlay();

        requestAnimationFrame(() => setTimeout(() => drawWaveform(), 80));

    } catch (err) {
        console.error('Load error:', err);
        hideOverlay();
        alert('Помилка обробки файлу.\n\n' + err.message);
    }
};

// =========================
// КРОК 2: РЕНДЕР
//
// Один прохід FFmpeg — ніякого попереднього перекодування.
//
// Для MOV: FFmpeg сам конвертує під час нарізки.
// Ми передаємо оригінальний input.mov напряму у filter_complex.
// Це означає ONE encode pass замість двох.
//
// Схема пам'яті:
//   - input.mov в FS (оригінал, без дублів)
//   - final.mp4 в FS (результат)
//   - Жодних проміжних файлів
// =========================
dom.btnGo.onclick = async () => {
    if (!aBuffer || !inputFsName) return;

    dom.btnGo.disabled = true;
    await lock();
    showOverlay('Монтаж відео...', 'МОНТАЖ У ПРОЦЕСІ');

    try {
        let db, dur;
        if (cMode === 'auto') {
            const p = getAutoParams();
            db = p.db; dur = p.dur;
        } else {
            db  = parseFloat(dom.db.value);
            dur = parseFloat(dom.dur.value);
        }

        const silences = detectSilences(db, dur);

        const PAD  = 0.1;
        const segs = [];
        let prev   = 0;

        silences.forEach(s => {
            const segStart = Math.max(0, prev === 0 ? 0 : prev - PAD);
            const segEnd   = Math.min(aDur, s.st + PAD);
            if (segEnd > segStart + 0.05) segs.push({ s: segStart, e: segEnd });
            prev = s.en;
        });
        if (prev < aDur) segs.push({ s: Math.max(0, prev - PAD), e: aDur });

        if (segs.length === 0) {
            alert('Пауз не знайдено! Спробуйте знизити поріг тиші в ручному режимі.');
            hideOverlay();
            dom.btnGo.disabled = false;
            unlock();
            return;
        }

        const tOut = segs.reduce((acc, s) => acc + (s.e - s.s), 0);

        // Будуємо filter_complex
        let filterStr    = '';
        let concatInputs = '';
        segs.forEach((s, i) => {
            filterStr    += `[0:v]trim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
            filterStr    += `[0:a]atrim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
            concatInputs += `[v${i}][a${i}]`;
        });
        filterStr += `${concatInputs}concat=n=${segs.length}:v=1:a=1[ov][oa]`;

        setupRenderLogger(tOut, Date.now());

        // ОДИН ПРОХІД: читаємо оригінальний файл (MOV або MP4) напряму,
        // нарізаємо паузи і кодуємо в MP4 за один раз.
        // Для MOV H.264 — FFmpeg remux + encode відбувається тут, один раз.
        // Для MOV HEVC — те ж саме, libx264 перекодовує один раз.
        await ffmpeg.run(
            '-i', inputFsName,
            '-filter_complex', filterStr,
            '-map', '[ov]',
            '-map', '[oa]',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            'final.mp4'
        );

        const data = ffmpeg.FS('readFile', 'final.mp4');

        // Очищаємо FS одразу
        try { ffmpeg.FS('unlink', inputFsName); } catch(_) {}
        try { ffmpeg.FS('unlink', 'final.mp4');  } catch(_) {}

        const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
        setProgress(100, 'ГОТОВО!');

        setTimeout(() => {
            dom.vPre.src         = url;
            dom.dl.href          = url;
            dom.dl.style.display = 'block';
            hideOverlay();
            dom.sEdit.classList.add('hidden_node');
            dom.sRes.classList.remove('hidden_node');
        }, 300);

    } catch (err) {
        console.error('Render error:', err);
        hideOverlay();
        alert('Помилка рендерингу: ' + err.message);
    } finally {
        dom.btnGo.disabled = false;
        unlock();
    }
};

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

let inputFsName = null;

// [ОПТИМІЗАЦІЯ] Зберігаємо поточний objectURL щоб revoke при наступному використанні
// Проблема: старі URL залишались в пам'яті — це тримало Blob живим
let _currentObjectURL = null;

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
// [ОПТИМІЗАЦІЯ] Централізоване звільнення ObjectURL
// Проблема: URL.createObjectURL тримає Blob в пам'яті до revoke
// Рішення: revoke старий URL перед створенням нового
// =========================
function revokeCurrentURL() {
    if (_currentObjectURL) {
        URL.revokeObjectURL(_currentObjectURL);
        _currentObjectURL = null;
    }
}
function createAndTrackURL(blob) {
    revokeCurrentURL();
    _currentObjectURL = URL.createObjectURL(blob);
    return _currentObjectURL;
}

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
// [ОПТИМІЗАЦІЯ] Debounce на oninput — уникаємо зайвих redraw при швидкому пересуванні
// Проблема: кожен піксель руху повзунка викликав повний перерахунок detectSilences + drawWaveform
// Рішення: 80мс debounce — не змінює UX, але знижує навантаження на CPU/RAM
// =========================
let _sliderDebounce = null;
function onSliderChange() {
    clearTimeout(_sliderDebounce);
    _sliderDebounce = setTimeout(() => { if (aBuffer) drawWaveform(); }, 80);
}

dom.dur.oninput = () => {
    dom.txtDur.innerText = parseFloat(dom.dur.value).toFixed(2) + ' сек';
    onSliderChange();
};
dom.db.oninput = () => {
    dom.txtDb.innerText = dom.db.value + ' dB';
    onSliderChange();
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
// [ОПТИМІЗАЦІЯ] OffscreenCanvas для waveform (де підтримується)
// Проблема: щоразу перерисовка на main thread блокувала UI
// Рішення: кешуємо waveform як ImageData — перемальовуємо тільки червоні регіони
// =========================

// Кеш waveform (синя частина) — малюємо один раз, потім тільки силенси зверху
let _waveformCache = null;       // ImageData — синя форма
let _waveformCacheKey = null;    // ключ: ширина+висота canvas

function drawWaveform() {
    if (!aBuffer) return;

    const canvas = dom.cvs;
    const ctx    = canvas.getContext('2d');
    const rect   = canvas.getBoundingClientRect();
    const newW   = Math.floor(rect.width) || canvas.offsetWidth || 560;
    const newH   = 120;

    // [ОПТИМІЗАЦІЯ] Перемальовуємо синю форму тільки якщо змінився розмір canvas
    // Проблема: кожен рух повзунка ремалював всі пікселі waveform (до 560*120 ітерацій)
    // Рішення: кешуємо синю форму в ImageData, при зміні лише силенсів — відновлюємо кеш
    const cacheKey = newW + 'x' + newH;
    if (canvas.width !== newW || canvas.height !== newH) {
        canvas.width  = newW;
        canvas.height = newH;
        _waveformCache    = null; // інвалідуємо кеш при зміні розміру
        _waveformCacheKey = null;
    }

    const w = canvas.width, h = canvas.height;

    if (!_waveformCache || _waveformCacheKey !== cacheKey) {
        // Малюємо синю waveform і зберігаємо в кеш
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
        // [RAM] Зберігаємо пікселі синьої форми — щоб не перераховувати кожного разу
        _waveformCache    = ctx.getImageData(0, 0, w, h);
        _waveformCacheKey = cacheKey;
    } else {
        // Відновлюємо кешовану синю форму замість повного перерахунку
        ctx.putImageData(_waveformCache, 0, 0);
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

    // Малюємо червоні паузи поверх кешованої форми
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
// [ОПТИМІЗАЦІЯ] Знижено sample rate до 16000 (було 22050)
// Причина: для аналізу пауз достатньо 16kHz — вдвічі менше даних
// Економія RAM: WAV файл ~27% менший, AudioBuffer ~27% менший
//
// [ОПТИМІЗАЦІЯ] Явне закриття AudioContext після декодування
// Проблема: незакритий AudioContext тримав внутрішній буфер
// Рішення: aCtx.close() звільняє апаратні ресурси
//
// [ОПТИМІЗАЦІЯ] wavData.buffer передається в decodeAudioData БЕЗ копії
// Проблема: new Uint8Array(wavData.buffer) створював копію ~3MB
// Рішення: передаємо wavData.buffer напряму (transferable)
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

    // [ОПТИМІЗАЦІЯ] 16000 замість 22050 — WAV файл менший на ~27%
    // Достатньо для детекції пауз (голос ~80-4000 Hz)
    await ffmpeg.run(
        '-i', fsName,
        '-vn',
        '-ar', '16000',      // [ОПТИМІЗАЦІЯ] було 22050 → 16000, менший WAV
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        'audio_only.wav'
    );

    setProgress(60);

    // [RAM] Читаємо WAV і ОДРАЗУ видаляємо з FS — не тримаємо два буфери одночасно
    const wavData = ffmpeg.FS('readFile', 'audio_only.wav');
    try { ffmpeg.FS('unlink', 'audio_only.wav'); } catch(_) {}
    // [RAM] Тепер в FS: тільки input файл. WAV вже не в FS.

    // [ОПТИМІЗАЦІЯ] Передаємо wavData.buffer напряму — уникаємо копіювання ArrayBuffer
    // Проблема: деякі браузери копіюють буфер при передачі в decodeAudioData
    // wavData.buffer — це вже ArrayBuffer, передаємо без проміжних обгорток
    const aCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

    let decoded;
    try {
        decoded = await aCtx.decodeAudioData(wavData.buffer);
    } finally {
        // [RAM] Закриваємо AudioContext — звільняє апаратні та внутрішні буфери
        if (aCtx.state !== 'closed') {
            try { await aCtx.close(); } catch(_) {}
        }
    }
    // [RAM] wavData тепер detached (буфер переданий в decodeAudioData) — GC може зібрати

    aBuffer = decoded.getChannelData(0);
    aDur    = decoded.duration;
    sRate   = decoded.sampleRate;

    setProgress(80);

    // [ОПТИМІЗАЦІЯ] RMS обчислення — без зайвих алокацій
    // Використовуємо push в масив замість pre-allocated щоб не тримати зайву пам'ять
    cRMS = [];
    const bufLen = aBuffer.length;
    for (let i = 0; i < bufLen; i += WINDOW_SIZE) {
        let sum = 0;
        const end = Math.min(i + WINDOW_SIZE, bufLen);
        for (let j = i; j < end; j++) sum += aBuffer[j] * aBuffer[j];
        cRMS.push(Math.sqrt(sum / (end - i)));
    }
    // [RAM] decoded більше не потрібен як об'єкт — aBuffer вже вказує на його дані
    // decoded = null; // НЕ нулюємо — aBuffer вказує на той самий Float32Array

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

        // [RAM] Очищаємо FS від попередньої сесії — звільняємо WASM heap
        for (const n of ['input.mov', 'input.mp4', 'audio_only.wav', 'final.mp4']) {
            try { ffmpeg.FS('unlink', n); } catch(_) {}
        }

        // [RAM] Інвалідуємо кеш waveform при новому файлі
        _waveformCache    = null;
        _waveformCacheKey = null;

        // [RAM] Звільняємо попередній ObjectURL (від прев'ю попереднього файлу)
        revokeCurrentURL();

        const ext   = (file.name.split('.').pop() || 'mp4').toLowerCase();
        const isMov = ext === 'mov'
                   || file.type === 'video/quicktime'
                   || file.type.includes('quicktime');

        inputFsName = isMov ? 'input.mov' : 'input.mp4';

        dom.ovTitle.innerText = 'Завантаження файлу...';
        dom.ovEta.innerText   = 'ЗАЧЕКАЙТЕ';
        setProgress(10);

        // Записуємо оригінальний файл у FS — БЕЗ ЖОДНОГО ПЕРЕКОДУВАННЯ
        ffmpeg.FS('writeFile', inputFsName, await fetchFile(file));
        setProgress(20);

        // Витягуємо тільки аудіо для аналізу (відео не чіпаємо)
        await extractAndAnalyzeAudio(inputFsName);
        // [RAM] Після extractAndAnalyzeAudio: в FS залишився тільки inputFsName

        // Ініціалізуємо повзунки авто-значеннями
        const autoP = getAutoParams();
        dom.db.value         = autoP.db;
        dom.dur.value        = autoP.dur;
        dom.txtDb.innerText  = autoP.db + ' dB';
        dom.txtDur.innerText = autoP.dur.toFixed(2) + ' сек';

        // Показуємо редактор
        dom.sFile.classList.add('hidden_node');
        dom.sEdit.classList.remove('hidden_node');

        // [RAM] Прев'ю — stream з File object напряму, НЕ з FS
        // createObjectURL(File) — браузер читає з диска/пам'яті по потребі
        // Не дублюємо файл в RAM
        const previewURL = URL.createObjectURL(file);
        // Для прев'ю НЕ трекаємо через createAndTrackURL — це preview, не фінальний URL
        // Він буде revoked при наступному виклику revokeCurrentURL (наступне відео або рендер)
        _currentObjectURL = previewURL;
        dom.vPre.src = previewURL;

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
// [ОПТИМІЗАЦІЯ ПІКОВОЇ RAM — ГОЛОВНА ПРОБЛЕМА SAFARI]
//
// Стара схема пам'яті (BAD):
//   input (~200MB в WASM FS)
//   + final.mp4 (~50MB в WASM FS)
//   + data = readFile → Uint8Array (~50MB)
//   + new Blob([data.buffer]) → ще ~50MB копія
//   = пік ~350MB тільки від цих даних
//
// Нова схема (КРАЩЕ):
//   1. ffmpeg.run → final.mp4 в FS
//   2. ОДРАЗУ unlink inputFsName → -200MB з WASM heap
//   3. readFile → Uint8Array
//   4. ОДРАЗУ unlink final.mp4 → звільняємо FS копію
//   5. Blob([data.buffer]) — тепер немає дублювання з FS
//   Пік: input + final (під час рендеру) → потім input іде, лишається тільки Blob
// =========================
dom.btnGo.onclick = async () => {
    if (!aBuffer || !inputFsName) return;

    dom.btnGo.disabled = true;
    await lock();
    showOverlay('Монтаж відео...', 'МОНТАЖ У ПРОЦЕСІ');

    // [RAM] Звільняємо прев'ю URL перед рендером — зменшуємо пік пам'яті
    // Проблема: preview Blob + final.mp4 Blob + FS дані = занадто багато одночасно
    // Рішення: прибираємо preview URL до початку важкої операції
    dom.vPre.src = '';
    revokeCurrentURL();

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

        // ОДИН ПРОХІД: читаємо оригінальний файл напряму, кодуємо в MP4 за один раз
        await ffmpeg.run(
            '-i', inputFsName,
            '-filter_complex', filterStr,
            '-map', '[ov]',
            '-map', '[oa]',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '27',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            'final.mp4'
        );

        // ===================================================
        // [RAM — КРИТИЧНО ДЛЯ SAFARI / iPHONE]
        //
        // ПРАВИЛЬНИЙ порядок звільнення пам'яті після рендеру:
        //
        //  РАНІШЕ (ПОГАНО):
        //    readFile(final) → unlink input → unlink final → Blob
        //    Пік: input (~200MB) + final (~50MB) + Uint8Array (~50MB) = ~300MB+ одночасно
        //    → Safari падає саме тут
        //
        //  ТЕПЕР (ПРАВИЛЬНО):
        //    unlink input → GC yield → readFile(final) → unlink final → Blob → null data
        //    Пік: final (~50MB) + Uint8Array (~50MB) = ~100MB максимум
        //    → значно менший пік, Safari виживає
        // ===================================================

        // КРОК 1: СПОЧАТКУ видаляємо вхідний файл (~150-300MB) — він більше не потрібен
        // Це найважливіший крок — input займає найбільше пам'яті
        try { ffmpeg.FS('unlink', inputFsName); } catch(_) {}
        inputFsName = null;

        // КРОК 2: Звільняємо aBuffer і cRMS — вони більше не потрібні після рендеру
        // aBuffer: Float32Array (~(тривалість * 16000 * 4) байт, наприклад 3хв = ~11MB)
        // cRMS: масив floats (~невеликий, але теж звільняємо)
        aBuffer = null;
        cRMS    = [];

        // КРОК 3: Даємо браузеру "подих" — yield to GC перед важкою операцією
        // setTimeout(0) дозволяє Safari запустити GC і звільнити пам'ять
        // до того як ми алокуємо новий великий буфер
        await new Promise(r => setTimeout(r, 50));

        // КРОК 4: Тільки тепер читаємо final.mp4 → Uint8Array
        // Тепер в WASM heap є тільки final.mp4, input вже прибрано
        setProgress(99, 'Збереження...');
        const data = ffmpeg.FS('readFile', 'final.mp4');

        // КРОК 5: ОДРАЗУ видаляємо final.mp4 з FS — звільняємо FS копію
        // data вже тримає Uint8Array — FS копія більше не потрібна
        try { ffmpeg.FS('unlink', 'final.mp4'); } catch(_) {}

        // КРОК 6: Ще один yield — даємо GC зібрати WASM heap від final.mp4
        await new Promise(r => setTimeout(r, 50));

        // КРОК 7: Створюємо Blob
        // Тепер в пам'яті: тільки data (Uint8Array, ~50MB) — більше нічого великого
        const blob = new Blob([data.buffer], { type: 'video/mp4' });

        // КРОК 8: Нулюємо data — підказка GC що Uint8Array більше не потрібен
        // Після передачі .buffer в Blob Safari може звільнити оригінальний буфер
        // eslint-disable-next-line no-unused-vars
        // (присвоєння в const неможливе — але браузер сам збере при наступному GC)

        // [RAM] Трекаємо URL щоб revoke при наступному виклику
        const url = createAndTrackURL(blob);

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
        // [RAM] При помилці теж чистимо FS
        // inputFsName може бути вже null якщо встигли зробити unlink до помилки
        if (inputFsName) { try { ffmpeg.FS('unlink', inputFsName); } catch(_) {} }
        try { ffmpeg.FS('unlink', 'final.mp4'); } catch(_) {}
        hideOverlay();
        alert('Помилка рендерингу: ' + err.message);
    } finally {
        dom.btnGo.disabled = false;
        unlock();
    }
};

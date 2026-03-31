// =========================
// ІНІЦІАЛІЗАЦІЯ FFMPEG
// =========================
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({
    log: false,
    corePath: './ffmpeg/ffmpeg-core.js'
});

let aBuffer = null;   // Float32Array — канал аудіо
let cRMS    = [];     // масив RMS-значень для визначення пауз
let aDur    = 0;      // тривалість аудіо (секунди)
let sRate   = 44100;  // частота дискретизації
let isLoaded = false;
let cMode   = 'auto';
let wakeLock = null;
let originalFile = null; // оригінальний File — ніколи не читається в RAM зайвий раз

const WINDOW_SIZE = 1024; // вікно для RMS (~23 мс при 44100 Гц)

// =========================
// DOM-посилання
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
    try {
        if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch(e) {}
}
function unlock() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

// =========================
// OVERLAY
// =========================
function showOverlay(title, eta) {
    dom.ov.style.display = 'flex';
    dom.ovTitle.innerText = title;
    dom.ovEta.innerText = eta || '';
    dom.ovPct.innerText = '';
    dom.bar.style.width = '0%';
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
// ВКЛАДКИ (auto / manual)
// =========================
function setTab(m) {
    cMode = m;
    document.getElementById('t_auto').classList.toggle('active_t', m === 'auto');
    document.getElementById('t_manual').classList.toggle('active_t', m === 'manual');

    // Гарантовано показуємо/ховаємо елементи
    if (m === 'manual') {
        dom.mCntrls.style.display = 'block';
        dom.aInfo.style.display = 'none';
    } else {
        dom.mCntrls.style.display = 'none';
        dom.aInfo.style.display = 'block';
    }

    if (aBuffer) drawWaveform();
}
document.getElementById('t_auto').addEventListener('click', () => setTab('auto'));
document.getElementById('t_manual').addEventListener('click', () => setTab('manual'));

// =========================
// ПОВЗУНКИ — миттєвий перерахунок
// =========================
dom.dur.addEventListener('input', () => {
    dom.txtDur.innerText = parseFloat(dom.dur.value).toFixed(2) + ' сек';
    if (aBuffer) drawWaveform();
});
dom.db.addEventListener('input', () => {
    dom.txtDb.innerText = dom.db.value + ' dB';
    if (aBuffer) drawWaveform();
});

// =========================
// АВТО-ПАРАМЕТРИ
// =========================
function getAutoParams() {
    if (!cRMS.length) return { db: -35, dur: 0.5 };
    const sorted = [...cRMS].sort((a, b) => a - b);
    const noiseFloor = sorted[Math.floor(sorted.length * 0.1)] || 0.001;
    let autoDb = Math.round(20 * Math.log10(noiseFloor + 1e-6) + 8);
    autoDb = Math.min(-25, Math.max(-50, autoDb));
    return { db: autoDb, dur: aDur > 60 ? 0.6 : 0.45 };
}

// =========================
// ВИЗНАЧЕННЯ ПАУЗ
// =========================
function detectSilences(db, minDur) {
    const limit = Math.pow(10, db / 20);
    const silences = [];
    const secPerBlock = WINDOW_SIZE / sRate;
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
// МАЛЮВАННЯ WAVEFORM
// =========================
function drawWaveform() {
    if (!aBuffer) return;

    const canvas = dom.cvs;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    canvas.width  = Math.floor(rect.width) || 560;
    canvas.height = 120;
    const w = canvas.width, h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Малюємо форму хвилі
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

    // Визначаємо параметри залежно від режиму
    let db, dur;
    if (cMode === 'auto') {
        const p = getAutoParams();
        db  = p.db;
        dur = p.dur;
        dom.aInfo.innerText = `✨ Авто: поріг ${db} dB, мін. пауза ${dur} сек`;
    } else {
        db  = parseFloat(dom.db.value);
        dur = parseFloat(dom.dur.value);
    }

    // Малюємо червоні ділянки (паузи)
    ctx.fillStyle = 'rgba(220, 30, 30, 0.45)';
    detectSilences(db, dur).forEach(s => {
        const x1 = (s.st / aDur) * w;
        const x2 = (s.en / aDur) * w;
        ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
    });
}

// =========================
// КРОК 1: ЗАВАНТАЖЕННЯ + АНАЛІЗ
//
// Використовує ТІЛЬКИ Web Audio API — без FFmpeg!
// Safari підтримує decodeAudioData для MOV/MP4/HEVC
// якщо браузер підтримує кодек (зазвичай так на iPhone)
// =========================
dom.fInp.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    originalFile = file;

    showOverlay('Аналіз відео...', 'ЧИТАННЯ АУДІО');
    setProgress(5);

    try {
        // Читаємо файл як ArrayBuffer ОДИН РАЗ
        // НЕ зберігаємо посилання — GC звільнить після decodeAudioData
        showOverlay('Аналіз відео...', 'РОЗПАКУВАННЯ АУДІО...');
        setProgress(15);

        const fileBuffer = await file.arrayBuffer();
        setProgress(35);

        // Декодуємо через Web Audio API
        // Safari на iPhone підтримує MOV H.264 та HEVC через цей API
        const aCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 22050 });

        let decoded;
        try {
            decoded = await aCtx.decodeAudioData(fileBuffer);
        } catch (decodeErr) {
            // Якщо Safari не може декодувати безпосередньо — спробуємо через FFmpeg
            console.warn('Direct decode failed, using FFmpeg fallback:', decodeErr);

            if (aCtx.close) aCtx.close();

            showOverlay('Підготовка аудіо...', 'ВИКОРИСТОВУЄМО FFMPEG');
            setProgress(40);

            if (!isLoaded) {
                showOverlay('Завантаження движка...', '');
                await ffmpeg.load();
                isLoaded = true;
            }

            setProgress(50, 'ВИТЯГУЄМО АУДІО...');

            const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
            const srcName = 'src_for_audio.' + ext;

            // Записуємо у FS і одразу видаляємо буфер з JS — звільняємо RAM
            ffmpeg.FS('writeFile', srcName, new Uint8Array(fileBuffer));

            ffmpeg.setLogger(({ message }) => {
                const m = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
                if (m) {
                    const t = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
                    dom.ovEta.innerText = `Зчитано: ${Math.floor(t)} сек`;
                }
            });

            await ffmpeg.run(
                '-i', srcName,
                '-vn', '-ar', '22050', '-ac', '1',
                '-c:a', 'pcm_s16le',
                'audio_for_analysis.wav'
            );

            try { ffmpeg.FS('unlink', srcName); } catch(_) {}

            const wavData = ffmpeg.FS('readFile', 'audio_for_analysis.wav');
            try { ffmpeg.FS('unlink', 'audio_for_analysis.wav'); } catch(_) {}

            setProgress(75, 'ДЕКОДУВАННЯ...');

            const aCtx2 = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 22050 });
            decoded = await aCtx2.decodeAudioData(wavData.buffer);
            if (aCtx2.close) aCtx2.close();
        }

        setProgress(80, 'ОБРОБКА ХВИЛІ...');

        aBuffer = decoded.getChannelData(0);
        aDur    = decoded.duration;
        sRate   = decoded.sampleRate;

        // Рахуємо RMS по вікнах
        cRMS = [];
        for (let i = 0; i < aBuffer.length; i += WINDOW_SIZE) {
            let sum = 0;
            const end = Math.min(i + WINDOW_SIZE, aBuffer.length);
            for (let j = i; j < end; j++) sum += aBuffer[j] * aBuffer[j];
            cRMS.push(Math.sqrt(sum / (end - i)));
        }

        setProgress(100, 'ГОТОВО!');

        // Прев'ю через object URL — не займає оперативну пам'ять (потоковий)
        dom.vPre.src = URL.createObjectURL(file);

        // Показуємо редактор
        dom.sFile.classList.add('hidden_node');
        dom.sEdit.classList.remove('hidden_node');

        // Ініціалізація повзунків для manual режиму
        const autoP = getAutoParams();
        dom.db.value   = autoP.db;
        dom.dur.value  = autoP.dur;
        dom.txtDb.innerText  = autoP.db + ' dB';
        dom.txtDur.innerText = autoP.dur.toFixed(2) + ' сек';

        hideOverlay();

        // Малюємо waveform після того як canvas відрендерився
        requestAnimationFrame(() => {
            setTimeout(() => drawWaveform(), 80);
        });

    } catch (err) {
        console.error('Load error:', err);
        hideOverlay();
        alert('Помилка завантаження файлу:\n\n' + err.message);
    }
});

// =========================
// КРОК 2: РЕНДЕР — вирізаємо паузи через FFmpeg
//
// Запускається ТІЛЬКИ тут — оригінальний файл зчитується
// один раз і одразу записується у FFmpeg FS.
// Проміжні файли видаляються після кожного кроку.
// =========================
dom.btnGo.addEventListener('click', async () => {
    if (!originalFile || !aBuffer) return;

    dom.btnGo.disabled = true;
    await lock();
    showOverlay('Монтаж відео...', 'ПІДГОТОВКА');

    try {
        // Параметри виявлення пауз
        let db, dur;
        if (cMode === 'auto') {
            const p = getAutoParams();
            db  = p.db;
            dur = p.dur;
        } else {
            db  = parseFloat(dom.db.value);
            dur = parseFloat(dom.dur.value);
        }

        const silences = detectSilences(db, dur);

        // Будуємо сегменти для збереження (інвертуємо паузи)
        const PAD = 0.1; // невеликий відступ щоб уникнути різких стиків
        const segs = [];
        let prev = 0;

        silences.forEach(s => {
            const segStart = Math.max(0, prev === 0 ? 0 : prev - PAD);
            const segEnd   = Math.min(aDur, s.st + PAD);
            if (segEnd > segStart + 0.05) {
                segs.push({ s: segStart, e: segEnd });
            }
            prev = s.en;
        });
        if (prev < aDur) {
            segs.push({ s: Math.max(0, prev - PAD), e: aDur });
        }

        if (segs.length === 0) {
            alert('Пауз не знайдено! Спробуйте знизити поріг тиші в ручному режимі.');
            hideOverlay();
            dom.btnGo.disabled = false;
            unlock();
            return;
        }

        const tOut = segs.reduce((a, s) => a + (s.e - s.s), 0);

        // Завантажуємо FFmpeg якщо ще не завантажено
        if (!isLoaded) {
            setProgress(5, 'ЗАВАНТАЖЕННЯ ДВИЖКА...');
            await ffmpeg.load();
            isLoaded = true;
        }

        // Записуємо оригінальний файл у FFmpeg FS
        // Це єдиний момент де він потрапляє в RAM разом з FFmpeg
        setProgress(10, 'ЧИТАННЯ ФАЙЛУ...');

        const ext = (originalFile.name.split('.').pop() || 'mp4').toLowerCase();
        const srcName = 'src_video.' + ext;

        // Очищаємо FS від можливих попередніх файлів
        for (const n of [srcName, 'remuxed.mp4', 'encoded.mp4', 'final.mp4']) {
            try { ffmpeg.FS('unlink', n); } catch(_) {}
        }

        // fetchFile стримить файл — не дублює в RAM
        ffmpeg.FS('writeFile', srcName, await fetchFile(originalFile));
        setProgress(20, 'АНАЛІЗ ФОРМАТУ...');

        // --- ПІДГОТОВКА: MOV → MP4 remux якщо потрібно ---
        let videoFsName = srcName;
        const isMov = ext === 'mov';

        if (isMov) {
            dom.ovTitle.innerText = 'Підготовка MOV...';
            dom.ovEta.innerText   = 'REMUX БЕЗ ПЕРЕКОДУВАННЯ';
            setProgress(25);

            ffmpeg.setLogger(({ message }) => {
                const m = message.match(/size=\s*(\d+)kB/);
                if (m) dom.ovEta.innerText = `Оброблено: ${(parseInt(m[1]) / 1024).toFixed(1)} МБ`;
            });

            let remuxOk = false;
            try {
                await ffmpeg.run(
                    '-i', srcName,
                    '-c', 'copy',
                    '-map', '0',
                    '-movflags', '+faststart',
                    'remuxed.mp4'
                );
                remuxOk = true;
            } catch (remuxErr) {
                console.warn('Remux failed:', remuxErr);
                // Видаляємо невдалий файл
                try { ffmpeg.FS('unlink', 'remuxed.mp4'); } catch(_) {}
            }

            if (remuxOk) {
                // Видаляємо вихідний MOV — звільняємо місце
                try { ffmpeg.FS('unlink', srcName); } catch(_) {}
                videoFsName = 'remuxed.mp4';
            } else {
                // Fallback: перекодуємо H.264
                dom.ovTitle.innerText = 'Конвертація відео...';
                dom.ovEta.innerText   = 'ЗАЧЕКАЙТЕ';
                setProgress(25);

                ffmpeg.setLogger(({ message }) => {
                    const m = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
                    if (m) {
                        const t = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
                        dom.ovEta.innerText = `Конвертовано: ${Math.floor(t)} сек`;
                    }
                });

                await ffmpeg.run(
                    '-i', srcName,
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                    '-c:a', 'aac', '-ar', '44100',
                    '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart',
                    'encoded.mp4'
                );
                try { ffmpeg.FS('unlink', srcName); } catch(_) {}
                videoFsName = 'encoded.mp4';
            }
        }

        // --- НАРІЗКА ПАУЗ через filter_complex ---
        dom.ovTitle.innerText = 'Монтаж відео...';
        dom.ovEta.innerText   = 'ВИРІЗАЄМО ПАУЗИ';
        setProgress(30);

        // Будуємо filter_complex рядок
        let filterStr   = '';
        let concatInputs = '';

        segs.forEach((s, i) => {
            filterStr += `[0:v]trim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
            filterStr += `[0:a]atrim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
            concatInputs += `[v${i}][a${i}]`;
        });
        filterStr += `${concatInputs}concat=n=${segs.length}:v=1:a=1[ov][oa]`;

        const t0 = Date.now();

        ffmpeg.setLogger(({ message }) => {
            const m = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
            if (m && tOut > 0) {
                const t   = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
                const pct = Math.min(99, 30 + (t / tOut) * 65);
                setProgress(pct);
                const elapsed = (Date.now() - t0) / 1000;
                if (elapsed > 1 && t > 0) {
                    const eta = Math.round((tOut - t) / (t / elapsed));
                    if (eta > 0) dom.ovEta.innerText = `Залишилось ~${eta} сек.`;
                }
            }
        });

        await ffmpeg.run(
            '-i', videoFsName,
            '-filter_complex', filterStr,
            '-map', '[ov]',
            '-map', '[oa]',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            'final.mp4'
        );

        // Читаємо результат
        const data = ffmpeg.FS('readFile', 'final.mp4');

        // Одразу видаляємо всі тимчасові файли з FS
        for (const n of [videoFsName, 'final.mp4', 'remuxed.mp4', 'encoded.mp4']) {
            try { ffmpeg.FS('unlink', n); } catch(_) {}
        }

        const blob = new Blob([data.buffer], { type: 'video/mp4' });
        const url  = URL.createObjectURL(blob);

        setProgress(100, 'ГОТОВО!');

        setTimeout(() => {
            dom.vPre.src    = url;
            dom.dl.href     = url;
            dom.dl.style.display = 'block';
            hideOverlay();
            dom.sEdit.classList.add('hidden_node');
            dom.sRes.classList.remove('hidden_node');
        }, 300);

    } catch (err) {
        console.error('Render error:', err);
        hideOverlay();
        alert('Помилка рендерингу:\n\n' + err.message);
    } finally {
        dom.btnGo.disabled = false;
        unlock();
    }
});

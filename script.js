// =========================
// ІНІЦІАЛІЗАЦІЯ FFMPEG
// =========================
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ log: false, corePath: './ffmpeg/ffmpeg-core.js' });

let aBuffer = null, cRMS = [], aDur = 0, sRate = 44100;
let isLoaded = false, cMode = 'auto', wakeLock = null;
let originalFile = null;   // оригінальний File (MOV або MP4)
let inputFsName = null;    // ім'я файлу в FFmpeg FS після першого кроку

const WINDOW_SIZE = 1024;

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
function unlock() { if (wakeLock) { wakeLock.release(); wakeLock = null; } }

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

dom.dur.oninput = () => { dom.txtDur.innerText = parseFloat(dom.dur.value).toFixed(2) + ' сек'; if (aBuffer) drawWaveform(); };
dom.db.oninput  = () => { dom.txtDb.innerText  = dom.db.value + ' dB';                           if (aBuffer) drawWaveform(); };

// =========================
// АВТО-ПАРАМЕТРИ
// =========================
function getAutoParams() {
    if (!cRMS.length) return { db: -35, dur: 0.5 };
    const sorted = [...cRMS].sort((a, b) => a - b);
    const noiseLevel = sorted[Math.floor(sorted.length * 0.1)] || 0.001;
    let autoDb = Math.round(20 * Math.log10(noiseLevel + 1e-6) + 8);
    autoDb = Math.min(-25, Math.max(-50, autoDb));
    return { db: autoDb, dur: aDur > 60 ? 0.6 : 0.45 };
}

// =========================
// ПОШУК ПАУЗ
// =========================
function detectSilences(db, minDur) {
    const limit = Math.pow(10, db / 20);
    const silences = [], secPerBlock = WINDOW_SIZE / sRate;
    let start = null;
    for (let i = 0; i < cRMS.length; i++) {
        const t = i * secPerBlock;
        if (cRMS[i] < limit) { if (start === null) start = t; }
        else if (start !== null) { if (t - start >= minDur) silences.push({ st: start, en: t }); start = null; }
    }
    if (start !== null) { const t = cRMS.length * secPerBlock; if (t - start >= minDur) silences.push({ st: start, en: t }); }
    return silences;
}

// =========================
// ХВИЛЯ
// =========================
function drawWaveform() {
    if (!aBuffer) return;
    const canvas = dom.cvs, ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.floor(rect.width) || 560;
    canvas.height = 120;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const step = Math.ceil(aBuffer.length / w);
    ctx.fillStyle = '#2b6cff';
    for (let i = 0; i < w; i++) {
        let mn = 1, mx = -1;
        for (let j = 0; j < step; j++) { const v = aBuffer[(i*step)+j]||0; if(v<mn)mn=v; if(v>mx)mx=v; }
        ctx.fillRect(i, (1+mn)*(h/2), 1, Math.max(1,(mx-mn)*(h/2)));
    }

    let db, dur;
    if (cMode === 'auto') {
        const p = getAutoParams(); db = p.db; dur = p.dur;
        dom.aInfo.innerText = `✨ Авто: поріг ${db} dB, мін. пауза ${dur} сек`;
    } else { db = parseFloat(dom.db.value); dur = parseFloat(dom.dur.value); }

    ctx.fillStyle = 'rgba(220,30,30,0.45)';
    detectSilences(db, dur).forEach(s => {
        const x1 = (s.st/aDur)*w, x2 = (s.en/aDur)*w;
        ctx.fillRect(x1, 0, Math.max(2, x2-x1), h);
    });
}

// =========================
// КРОК 1: ЗАВАНТАЖЕННЯ
//
// Підхід: FFmpeg витягує ТІЛЬКИ аудіо (маленький WAV ~2-5 MB)
// Відео НЕ перекодується — залишається як є в FS
// Це вирішує і проблему пам'яті, і підтримку MOV HEVC + H.264
// =========================
dom.fInp.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    originalFile = file;
    showOverlay('Завантаження движка...', '');

    try {
        // Завантажуємо FFmpeg один раз
        if (!isLoaded) {
            await ffmpeg.load();
            isLoaded = true;
        }

        showOverlay('Читання відео...', '');
        setProgress(10);

        // Очищаємо FS від попередніх файлів
        for (const n of ['src_video', 'audio_raw.wav']) {
            try { ffmpeg.FS('unlink', n); } catch(_) {}
        }

        // Визначаємо ім'я файлу для FS (зберігаємо розширення для FFmpeg)
        const ext = file.name.split('.').pop().toLowerCase() || 'mp4';
        const srcName = 'src_video.' + ext;

        // Записуємо вихідний файл в FFmpeg FS
        ffmpeg.FS('writeFile', srcName, await fetchFile(file));
        setProgress(30, 'АНАЛІЗ АУДІО...');

        // Витягуємо ТІЛЬКИ аудіо — маленький WAV
        // -vn = без відео
        // -ar 22050 = знижена частота (достатньо для аналізу пауз, вдвічі менше даних)
        // -ac 1 = моно
        // -t 7200 = максимум 2 години (захист від нескінченного файлу)
        // pcm_s16le = без стиснення, Safari точно декодує
        ffmpeg.setLogger(({ message }) => {
            // Показуємо прогрес витягнення аудіо
            const mTime = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
            if (mTime) {
                const t = parseInt(mTime[1])*3600 + parseInt(mTime[2])*60 + parseFloat(mTime[3]);
                // Не знаємо загальну тривалість на цьому етапі, просто показуємо час
                dom.ovEta.innerText = `Зчитано: ${Math.floor(t)} сек`;
            }
        });

        await ffmpeg.run(
            '-i', srcName,
            '-vn',
            '-ar', '22050',
            '-ac', '1',
            '-c:a', 'pcm_s16le',
            '-t', '7200',
            'audio_raw.wav'
        );

        setProgress(70, 'ОБРОБКА...');

        // Читаємо маленький WAV (2-5 MB замість 200 MB!)
        const wavData = ffmpeg.FS('readFile', 'audio_raw.wav');
        try { ffmpeg.FS('unlink', 'audio_raw.wav'); } catch(_) {}

        // Декодуємо через Web Audio API — WAV декодується скрізь без проблем
        const aCtx = new (window.AudioContext || window.webkitAudioContext)();
        const decoded = await aCtx.decodeAudioData(wavData.buffer);
        if (aCtx.close) aCtx.close();

        aBuffer = decoded.getChannelData(0);
        aDur    = decoded.duration;
        sRate   = decoded.sampleRate;

        // Кеш RMS
        cRMS = [];
        for (let i = 0; i < aBuffer.length; i += WINDOW_SIZE) {
            let sum = 0;
            for (let j = 0; j < WINDOW_SIZE; j++) { const v = aBuffer[i+j]||0; sum += v*v; }
            cRMS.push(Math.sqrt(sum / WINDOW_SIZE));
        }

        // Зберігаємо ім'я вихідного відео в FS — воно знадобиться при рендерингу
        inputFsName = srcName;

        setProgress(100);

        // Показуємо редактор
        dom.sFile.classList.add('hidden_node');
        dom.sEdit.classList.remove('hidden_node');

        // Прев'ю (браузер стримить з диска — не займає оперативну пам'ять)
        dom.vPre.src = URL.createObjectURL(file);

        dom.ov.style.display = 'none';
        requestAnimationFrame(() => setTimeout(() => drawWaveform(), 80));

    } catch (err) {
        console.error('Load error:', err);
        alert('Помилка завантаження файлу:\n\n' + err.message);
        dom.ov.style.display = 'none';
    }
};

// =========================
// КРОК 2: РЕНДЕРИНГ — вирізаємо паузи
//
// inputFsName вже є в FFmpeg FS з кроку 1
// Якщо це MOV — remux в MP4 перед обробкою (без перекодування!)
// Потім ріжемо паузи
// =========================
dom.btnGo.onclick = async () => {
    if (!inputFsName || !aBuffer) return;
    dom.btnGo.disabled = true;
    await lock();
    showOverlay('Монтаж відео...', 'ПІДГОТОВКА');

    try {
        let db, dur;
        if (cMode === 'auto') { const p = getAutoParams(); db = p.db; dur = p.dur; }
        else { db = parseFloat(dom.db.value); dur = parseFloat(dom.dur.value); }

        const silences = detectSilences(db, dur);
        const PAD = 0.1;
        const segs = [];
        let prev = 0;
        silences.forEach(s => {
            if (s.st > prev) segs.push({ s: Math.max(0, prev-(prev===0?0:PAD)), e: Math.min(aDur, s.st+PAD) });
            prev = s.en;
        });
        if (prev < aDur) segs.push({ s: Math.max(0, prev-PAD), e: aDur });

        if (segs.length === 0) {
            alert('Пауз не знайдено! Спробуйте знизити поріг тиші в ручному режимі.');
            dom.ov.style.display = 'none';
            dom.btnGo.disabled = false;
            unlock();
            return;
        }

        const tOut = segs.reduce((a, s) => a + (s.e - s.s), 0);

        // Якщо вихідний файл MOV — робимо швидкий remux в MP4 (без перекодування)
        // Це потрібно бо concat filter не працює з MOV контейнером
        let videoFsName = inputFsName;
        const isMov = inputFsName.endsWith('.mov');

        if (isMov) {
            dom.ovTitle.innerText = 'Підготовка MOV...';
            dom.ovEta.innerText = 'КІЛЬКА СЕКУНД';

            // Логер для remux (показуємо МБ)
            ffmpeg.setLogger(({ message }) => {
                const m = message.match(/size=\s*(\d+)kB/);
                if (m) dom.ovEta.innerText = `Оброблено: ${(parseInt(m[1])/1024).toFixed(1)} МБ`;
            });

            try {
                await ffmpeg.run(
                    '-i', inputFsName,
                    '-c', 'copy',
                    '-map', '0',
                    '-movflags', '+faststart',
                    'remuxed.mp4'
                );
                // Видаляємо MOV — звільняємо місце
                try { ffmpeg.FS('unlink', inputFsName); } catch(_) {}
                videoFsName = 'remuxed.mp4';
            } catch (remuxErr) {
                // Якщо remux не вийшов — перекодовуємо
                console.warn('Remux failed, encoding...', remuxErr);
                dom.ovTitle.innerText = 'Підготовка відео...';
                dom.ovEta.innerText = 'ЗАЧЕКАЙТЕ';

                ffmpeg.setLogger(({ message }) => {
                    const m = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
                    if (m) {
                        const t = parseInt(m[1])*3600+parseInt(m[2])*60+parseFloat(m[3]);
                        dom.ovEta.innerText = `Підготовлено: ${Math.floor(t)} сек`;
                    }
                });

                try { ffmpeg.FS('unlink', 'remuxed.mp4'); } catch(_) {}
                await ffmpeg.run(
                    '-i', inputFsName,
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                    '-c:a', 'aac', '-ar', '44100',
                    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                    'encoded.mp4'
                );
                try { ffmpeg.FS('unlink', inputFsName); } catch(_) {}
                videoFsName = 'encoded.mp4';
            }
        }

        // --- Вирізаємо паузи ---
        dom.ovTitle.innerText = 'Монтаж відео...';
        dom.ovEta.innerText = 'МОНТАЖ У ПРОЦЕСІ';
        setProgress(0);

        let filterStr = '', concatInputs = '';
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
                const t = parseInt(m[1])*3600+parseInt(m[2])*60+parseFloat(m[3]);
                const pct = Math.min(99, (t/tOut)*100);
                setProgress(pct);
                const elapsed = (Date.now()-t0)/1000;
                if (elapsed > 1 && t > 0) {
                    const eta = Math.round((tOut-t)/(t/elapsed));
                    if (eta > 0) dom.ovEta.innerText = `Залишилось ~${eta} сек.`;
                }
            }
        });

        await ffmpeg.run(
            '-i', videoFsName,
            '-filter_complex', filterStr,
            '-map', '[ov]', '-map', '[oa]',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            'final.mp4'
        );

        const data = ffmpeg.FS('readFile', 'final.mp4');
        try { ffmpeg.FS('unlink', videoFsName); } catch(_) {}
        try { ffmpeg.FS('unlink', 'final.mp4'); } catch(_) {}

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
        console.error('Render error:', err);
        alert('Помилка рендерингу: ' + err.message);
        dom.ov.style.display = 'none';
    } finally {
        dom.btnGo.disabled = false;
        unlock();
    }
};

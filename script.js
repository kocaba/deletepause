const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ log: false, corePath: './ffmpeg/ffmpeg-core.js' });

let aBuffer = null, cRMS = [], aDur = 0, sRate = 44100, isLoaded = false, cMode = 'auto';
let wakeLock = null;
let currentFile = null;

const dom = {
    fInp: document.getElementById('real_f'),
    sFile: document.getElementById('step_file'),
    sEdit: document.getElementById('step_editor'),
    sRes: document.getElementById('step_result'),
    ov: document.getElementById('ov_scr_55'),
    ovTitle: document.getElementById('ov_title'),
    bar: document.getElementById('p_bar_fill'),
    ovPct: document.getElementById('ov_pct'),
    cvs: document.getElementById('wv_cvs_11'),
    btnGo: document.getElementById('go_proc'),
    vPre: document.getElementById('vid_pre_77'),
    dl: document.getElementById('dl_btn_99'),
    dur: document.getElementById('val_dur'),
    db: document.getElementById('val_db'),
    tDur: document.getElementById('txt_dur'),
    tDb: document.getElementById('txt_db')
};

// --- ФУНКЦІЇ МАЛЮВАННЯ ---

function draw() {
    if (!aBuffer) return;
    const ctx = dom.cvs.getContext('2d');
    const w = dom.cvs.width = dom.cvs.clientWidth;
    const h = dom.cvs.height = dom.cvs.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // 1. Малюємо хвилю
    const step = Math.ceil(aBuffer.length / w);
    ctx.fillStyle = "#2b6cff";
    for (let i = 0; i < w; i++) {
        let min = 1, max = -1;
        for (let j = 0; j < step; j++) {
            const v = aBuffer[(i * step) + j] || 0;
            if (v < min) min = v; if (v > max) max = v;
        }
        ctx.fillRect(i, (1 + min) * (h / 2), 1, Math.max(1, (max - min) * (h / 2)));
    }

    // 2. Малюємо ЧЕРВОНІ зони (паузи)
    const p = cMode === 'auto' ? getAutoParams() : { db: parseFloat(dom.db.value), dur: parseFloat(dom.dur.value) };
    const silences = detectSilences(p.db, p.dur);
    
    ctx.fillStyle = "rgba(255, 0, 0, 0.4)";
    silences.forEach(s => {
        const xStart = (s.st / aDur) * w;
        const xEnd = (s.en / aDur) * w;
        ctx.fillRect(xStart, 0, xEnd - xStart, h);
    });
}

function detectSilences(db, minDur) {
    const lim = Math.pow(10, db / 20);
    const sil = [];
    let st = null;
    const bT = 1024 / sRate; // Час одного блоку RMS

    cRMS.forEach((v, i) => {
        const t = i * bT;
        if (v < lim) {
            if (st === null) st = t;
        } else {
            if (st !== null) {
                if (t - st >= minDur) sil.push({ st, en: t });
                st = null;
            }
        }
    });
    return sil;
}

function getAutoParams() {
    const s = [...cRMS].sort((a, b) => a - b);
    const n = s[Math.floor(s.length * 0.1)] || 0.001;
    let db = Math.round(20 * Math.log10(n + 1e-6) + 10);
    return { db: Math.min(-30, Math.max(-45, db)), dur: 0.45 };
}

// --- ОБРОБНИКИ ПОДІЙ ---

dom.dur.oninput = () => { dom.tDur.innerText = dom.dur.value; draw(); };
dom.db.oninput = () => { dom.tDb.innerText = dom.db.value; draw(); };

function setTab(m) {
    cMode = m;
    document.getElementById('t_auto').classList.toggle('active_t', m === 'auto');
    document.getElementById('t_manual').classList.toggle('active_t', m === 'manual');
    document.getElementById('m_cntrls').classList.toggle('hidden_node', m === 'auto');
    draw();
}
document.getElementById('t_auto').onclick = () => setTab('auto');
document.getElementById('t_manual').onclick = () => setTab('manual');

// --- ЗАВАНТАЖЕННЯ ТА ПІДГОТОВКА ---

dom.fInp.onchange = async (e) => {
    let file = e.target.files[0]; if (!file) return;
    dom.ov.style.display = 'flex';
    dom.ovTitle.innerText = "Завантаження...";

    if (!isLoaded) { await ffmpeg.load(); isLoaded = true; }

    // Вирішуємо проблему iPhone (MOV/H264 сумісність)
    // Швидко переганяємо в чистий MP4, щоб AudioContext його точно з'їв
    ffmpeg.FS("writeFile", "tmp_in", await fetchFile(file));
    
    // Відображаємо прогрес конвертації
    ffmpeg.setLogger(({ message }) => {
        if (message.includes('time=')) dom.ovTitle.innerText = "Підготовка для iPhone...";
    });

    await ffmpeg.run("-i", "tmp_in", "-c:v", "copy", "-c:a", "aac", "tmp_out.mp4");
    const data = ffmpeg.FS("readFile", "tmp_out.mp4");
    currentFile = new File([data.buffer], "video.mp4", { type: "video/mp4" });

    const aCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuf = await data.buffer.slice(0); // копія для декодування
    const dec = await aCtx.decodeAudioData(arrayBuf);

    aBuffer = dec.getChannelData(0); aDur = dec.duration; sRate = dec.sampleRate;
    
    // Рахуємо RMS для графіку
    const s = 1024; cRMS = [];
    for (let i = 0; i < aBuffer.length; i += s) {
        let sum = 0; for (let j = 0; j < s; j++) { const v = aBuffer[i + j] || 0; sum += v * v; }
        cRMS.push(Math.sqrt(sum / s));
    }

    dom.sFile.classList.add('hidden_node');
    dom.sEdit.classList.remove('hidden_node');
    draw();
    dom.vPre.src = URL.createObjectURL(currentFile);
    dom.ov.style.display = 'none';
};

// --- ФІНАЛЬНИЙ МОНТАЖ ---

dom.btnGo.onclick = async () => {
    if (!currentFile) return;
    dom.btnGo.disabled = true;
    dom.ov.style.display = 'flex';
    dom.ovTitle.innerText = "Монтаж відео...";

    const p = cMode === 'auto' ? getAutoParams() : { db: parseFloat(dom.db.value), dur: parseFloat(dom.dur.value) };
    const silences = detectSilences(p.db, p.dur);

    const segs = []; let prev = 0, PAD = 0.1;
    silences.forEach(s => {
        if (s.st > prev) segs.push({ s: Math.max(0, prev - (prev === 0 ? 0 : PAD)), e: s.st + PAD });
        prev = s.en;
    });
    if (prev < aDur) segs.push({ s: Math.max(0, prev - PAD), e: aDur });
    
    const tOut = segs.reduce((a, s) => a + (s.e - s.s), 0);

    ffmpeg.setLogger(({ message }) => {
        const m = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (m) {
            const t = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
            const pct = Math.min(100, (t / tOut) * 100);
            dom.bar.style.width = pct + "%";
            dom.ovPct.innerText = pct.toFixed(0) + "%";
        }
    });

    let f = "", c = "";
    segs.forEach((s, i) => {
        f += `[0:v]trim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
        f += `[0:a]atrim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
        c += `[v${i}][a${i}]`;
    });
    f += `${c}concat=n=${segs.length}:v=1:a=1[v][a]`;

    try {
        await ffmpeg.run("-i", "tmp_out.mp4", "-filter_complex", f, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "final.mp4");
        const data = ffmpeg.FS("readFile", "final.mp4");
        const url = URL.createObjectURL(new Blob([data.buffer], { type: "video/mp4" }));
        dom.vPre.src = url; dom.dl.href = url;
        dom.ov.style.display = 'none';
        dom.sEdit.classList.add('hidden_node');
        dom.sRes.classList.remove('hidden_node');
    } catch (e) { alert("Помилка монтажу"); dom.ov.style.display = 'none'; }
    finally { dom.btnGo.disabled = false; }
};

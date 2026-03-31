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
    txtDur: document.getElementById('txt_dur'),
    txtDb: document.getElementById('txt_db')
};

// Блокування вимкнення екрана
async function lock() { try { if('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch(e){} }

// Малювання хвилі та ЧЕРВОНИХ зон
function draw() {
    if (!aBuffer) return;
    const ctx = dom.cvs.getContext('2d');
    const w = dom.cvs.width = dom.cvs.clientWidth * 2; // для чіткості на iPhone
    const h = dom.cvs.height = dom.cvs.clientHeight * 2;
    ctx.scale(2, 2);
    const sw = dom.cvs.clientWidth;
    const sh = dom.cvs.clientHeight;

    ctx.clearRect(0,0,sw,sh);
    
    // Параметри тиші
    let p_db, p_dur;
    if(cMode === 'auto') {
        const auto = getAutoParams();
        p_db = auto.db; p_dur = auto.dur;
    } else {
        p_db = parseFloat(dom.db.value);
        p_dur = parseFloat(dom.dur.value);
    }

    const limit = Math.pow(10, p_db / 20);
    const step = Math.ceil(aBuffer.length / sw);

    // Малюємо основну хвилю
    ctx.fillStyle = "#2b6cff";
    for(let i=0; i<sw; i++) {
        let max = 0;
        for(let j=0; j<step; j++) {
            const v = Math.abs(aBuffer[i*step + j] || 0);
            if(v > max) max = v;
        }
        ctx.fillRect(i, sh/2 - (max * sh/2), 1, max * sh);
    }

    // Малюємо ЧЕРВОНІ зони видалення
    ctx.fillStyle = "rgba(255, 0, 0, 0.4)";
    let startIdx = null;
    const secPerBlock = 1024 / sRate;

    cRMS.forEach((rms, i) => {
        const time = i * secPerBlock;
        if (rms < limit) {
            if (startIdx === null) startIdx = time;
        } else {
            if (startIdx !== null) {
                if (time - startIdx >= p_dur) {
                    const x1 = (startIdx / aDur) * sw;
                    const x2 = (time / aDur) * sw;
                    ctx.fillRect(x1, 0, x2 - x1, sh);
                }
                startIdx = null;
            }
        }
    });
}

// Авто-параметри
function getAutoParams() {
    const s = [...cRMS].sort((a,b)=>a-b);
    const n = s[Math.floor(s.length*0.1)] || 0.01;
    let db = Math.round(20 * Math.log10(n + 1e-6) + 6);
    return { db: Math.min(-30, Math.max(-45, db)), dur: aDur > 60 ? 0.6 : 0.45 };
}

// Завантаження файлу
dom.fInp.onchange = async (e) => {
    let file = e.target.files[0]; if(!file) return;
    dom.ov.style.display = 'flex';
    dom.ovTitle.innerText = "Підготовка відео...";

    if(!isLoaded) { await ffmpeg.load(); isLoaded = true; }

    // iPhone MOV FIX: Конвертуємо в зрозумілий MP4
    ffmpeg.FS("writeFile", "in_raw", await fetchFile(file));
    dom.ovTitle.innerText = "Оптимізація для iPhone...";
    // Перекодовуємо в h264 зі швидким пресетом, щоб браузер міг працювати з файлом
    await ffmpeg.run("-i", "in_raw", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-c:a", "aac", "ready.mp4");
    
    const data = ffmpeg.FS("readFile", "ready.mp4");
    currentFile = new File([data.buffer], "video.mp4", {type:"video/mp4"});
    
    // Декодування звуку
    const aCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuf = await currentFile.arrayBuffer();
    const dec = await aCtx.decodeAudioData(arrayBuf);
    aBuffer = dec.getChannelData(0); aDur = dec.duration; sRate = dec.sampleRate;

    // RMS
    cRMS = []; const s = 1024;
    for (let i = 0; i < aBuffer.length; i += s) {
        let sum = 0; for (let j = 0; j < s; j++) { const v = aBuffer[i+j]||0; sum += v*v; }
        cRMS.push(Math.sqrt(sum/s));
    }

    dom.ov.style.display = 'none';
    dom.sFile.classList.add('hidden_node');
    dom.sEdit.classList.remove('hidden_node');
    draw();
    dom.vPre.src = URL.createObjectURL(currentFile);
};

// Динамічне оновлення
dom.dur.oninput = () => { dom.txtDur.innerText = dom.dur.value; draw(); };
dom.db.oninput = () => { dom.txtDb.innerText = dom.db.value; draw(); };
document.getElementById('t_auto').onclick = () => { cMode='auto'; draw(); dom.m_cntrls.classList.add('hidden_node'); };
document.getElementById('t_manual').onclick = () => { cMode='manual'; draw(); dom.m_cntrls.classList.remove('hidden_node'); };

// Процес обробки
dom.btnGo.onclick = async () => {
    await lock();
    dom.ov.style.display = 'flex';
    dom.ovTitle.innerText = "Видалення пауз...";
    
    const p = cMode==='auto' ? getAutoParams() : {db: parseFloat(dom.db.value), dur: parseFloat(dom.dur.value)};
    const lim = Math.pow(10, p.db/20), sil = []; let st = null; const bT = 1024/sRate;
    
    cRMS.forEach((v, i) => {
        const t = i * bT;
        if (v < lim) { if (st === null) st = t; }
        else if (st !== null) { if (t - st >= p.dur) sil.push({st, en: t}); st = null; }
    });

    const segs = []; let prev = 0, PAD = 0.1;
    sil.forEach(s => {
        if(s.st > prev) segs.push({s: Math.max(0, prev-(prev===0?0:PAD)), e: s.st+PAD});
        prev = s.en;
    });
    if(prev < aDur) segs.push({s: Math.max(0, prev-PAD), e: aDur});
    
    const totalOutDur = segs.reduce((a,s)=>a+(s.e-s.s), 0);

    let filter = "", concat = "";
    segs.forEach((s, i) => {
        filter += `[0:v]trim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
        filter += `[0:a]atrim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
        concat += `[v${i}][a${i}]`;
    });
    filter += `${concat}concat=n=${segs.length}:v=1:a=1[v][a]`;

    ffmpeg.setLogger(({message}) => {
        const m = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if(m){
            const t = parseInt(m[1])*3600+parseInt(m[2])*60+parseFloat(m[3]);
            const pct = Math.min(99, Math.round((t / totalOutDur) * 100));
            dom.bar.style.width = pct + "%";
            dom.ovPct.innerText = pct + "%";
        }
    });

    await ffmpeg.run("-i", "ready.mp4", "-filter_complex", filter, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "out.mp4");
    
    const data = ffmpeg.FS("readFile", "out.mp4");
    const url = URL.createObjectURL(new Blob([data.buffer], {type:"video/mp4"}));
    dom.vPre.src = url; dom.dl.href = url;
    dom.ov.style.display = 'none';
    dom.sEdit.classList.add('hidden_node');
    dom.sRes.classList.remove('hidden_node');
};

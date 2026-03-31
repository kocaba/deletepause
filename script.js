const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ log: false, corePath: './ffmpeg/ffmpeg-core.js' });

let aBuffer = null, cRMS = [], aDur = 0, sRate = 44100, isLoaded = false, cMode = 'auto', wakeLock = null;
let currentProcessedFile = null;

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
    db: document.getElementById('val_db')
};

// Блокування сну екрана
async function lock() { try { if('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch(e){} }
function unlock() { if(wakeLock) { wakeLock.release(); wakeLock = null; } }

// Перемикання табів
function setTab(m) {
    cMode = m;
    document.getElementById('t_auto').classList.toggle('active_t', m==='auto');
    document.getElementById('t_manual').classList.toggle('active_t', m==='manual');
    document.getElementById('m_cntrls').classList.toggle('hidden_node', m==='auto');
    document.getElementById('a_info').classList.toggle('hidden_node', m==='manual');
    if(aBuffer) draw();
}
document.getElementById('t_auto').onclick = () => setTab('auto');
document.getElementById('t_manual').onclick = () => setTab('manual');

// Малювання хвилі
function draw() {
    const ctx = dom.cvs.getContext('2d');
    dom.cvs.width = dom.cvs.clientWidth; dom.cvs.height = dom.cvs.clientHeight;
    const w = dom.cvs.width, h = dom.cvs.height;
    ctx.clearRect(0,0,w,h);
    if(!aBuffer) return;
    const step = Math.ceil(aBuffer.length/w);
    ctx.fillStyle = "#2b6cff";
    for(let i=0; i<w; i++){
        let min=1, max=-1;
        for(let j=0; j<step; j++){
            const v = aBuffer[(i*step)+j]||0;
            if(v<min) min=v; if(v>max) max=v;
        }
        ctx.fillRect(i, (1+min)*(h/2), 1, Math.max(1,(max-min)*(h/2)));
    }
}

// ПЕРШИЙ КРОК: ЗАВАНТАЖЕННЯ ТА REMUXING
dom.fInp.onchange = async (e) => {
    let file = e.target.files[0]; if(!file) return;

    dom.ov.style.display = 'flex';
    dom.ovTitle.innerText = "Аналіз файлу...";

    try {
        if (!isLoaded) { await ffmpeg.load(); isLoaded = true; }

        const ext = file.name.split('.').pop().toLowerCase();
        
        // --- ВАРІАНТ А: REMUXING ДЛЯ IPHONE ---
        if (ext === 'mov' || file.type.includes('quicktime')) {
            dom.ovTitle.innerText = "Конвертація iPhone MOV -> MP4...";
            ffmpeg.FS("writeFile", "temp_in.mov", await fetchFile(file));
            
            // Швидка перепаковка без втрати якості
            await ffmpeg.run("-i", "temp_in.mov", "-c", "copy", "-map", "0", "temp_out.mp4");
            
            const data = ffmpeg.FS("readFile", "temp_out.mp4");
            file = new File([data.buffer], "ready.mp4", { type: "video/mp4" });
            
            ffmpeg.FS("unlink", "temp_in.mov");
            ffmpeg.FS("unlink", "temp_out.mp4");
        }
        
        currentProcessedFile = file;

        // Декодування аудіо (Тепер з MP4 це працює стабільно)
        const aCtx = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuf = await file.arrayBuffer();
        const dec = await aCtx.decodeAudioData(arrayBuf);

        aBuffer = dec.getChannelData(0); aDur = dec.duration; sRate = dec.sampleRate;
        
        // Розрахунок RMS для аналізу
        const s = 1024; cRMS = [];
        for (let i = 0; i < aBuffer.length; i += s) {
            let sum = 0; for (let j = 0; j < s; j++) { const v = aBuffer[i+j]||0; sum += v*v; }
            cRMS.push(Math.sqrt(sum/s));
        }

        dom.sFile.classList.add('hidden_node');
        dom.sEdit.classList.remove('hidden_node');
        draw();
        dom.vPre.src = URL.createObjectURL(file);
        dom.ov.style.display = 'none';

    } catch (err) { 
        console.error(err);
        alert("Помилка обробки. iPhone не зміг прочитати структуру цього файлу."); 
        dom.ov.style.display = 'none'; 
    }
};

// ДРУГИЙ КРОК: СКЛЕЙКА
dom.btnGo.onclick = async () => {
    if(!currentProcessedFile) return;
    dom.btnGo.disabled = true;
    await lock();
    dom.ov.style.display = 'flex';
    dom.ovTitle.innerText = "Монтаж відео...";
    
    const dbVal = cMode==='auto' ? -35 : parseFloat(dom.db.value);
    const pDur = 0.5; // мін довжина паузи
    
    const lim = Math.pow(10, dbVal/20), sil = []; let st = null; const bT = 1024/sRate;
    cRMS.forEach((v, i) => {
        const t = i * bT;
        if (v < lim) { if (st === null) st = t; }
        else if (st !== null) { if (t - st >= pDur) sil.push({st, en: t}); st = null; }
    });

    const segs = []; let prev = 0, PAD = 0.1;
    sil.forEach(s => {
        if(s.st > prev) segs.push({s: Math.max(0, prev-(prev===0?0:PAD)), e: s.st+PAD});
        prev = s.en;
    });
    if(prev < aDur) segs.push({s: Math.max(0, prev-PAD), e: aDur});
    const tOut = segs.reduce((a,s)=>a+(s.e-s.s), 0);
    
    ffmpeg.FS("writeFile", "working.mp4", await fetchFile(currentProcessedFile));
    
    let f = "", c = "";
    segs.forEach((s, i) => {
        f += `[0:v]trim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
        f += `[0:a]atrim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
        c += `[v${i}][a${i}]`;
    });
    f += `${c}concat=n=${segs.length}:v=1:a=1[v][a]`;

    ffmpeg.setLogger(({message}) => {
        const m = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if(m){
            const t = parseInt(m[1])*3600+parseInt(m[2])*60+parseFloat(m[3]);
            const pct = Math.min(100, (t/tOut)*100);
            dom.bar.style.width = pct+"%";
            dom.ovPct.innerText = pct.toFixed(0)+"%";
        }
    });

    try {
        // Рендеринг з H.264 та AAC - найбільш сумісні кодеки для iOS
        await ffmpeg.run("-i", "working.mp4", "-filter_complex", f, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "final.mp4");
        
        const data = ffmpeg.FS("readFile", "final.mp4");
        const url = URL.createObjectURL(new Blob([data.buffer], {type:"video/mp4"}));
        
        dom.vPre.src = url; dom.dl.href = url; dom.dl.style.display = "block";
        dom.ov.style.display = 'none';
        dom.sEdit.classList.add('hidden_node');
        dom.sRes.classList.remove('hidden_node');
    } catch (e) { alert("Помилка рендерингу."); dom.ov.style.display = 'none'; }
    finally { dom.btnGo.disabled = false; unlock(); }
};

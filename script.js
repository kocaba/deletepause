const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ 
    log: false, 
    corePath: './ffmpeg/ffmpeg-core.js' 
});

let aBuffer = null, cRMS = [], aDur = 0, sRate = 44100, isLoaded = false, cMode = 'auto', wakeLock = null;

const dom = {
    fInp: document.getElementById('real_f'),
    sFile: document.getElementById('step_file'),
    sEdit: document.getElementById('step_editor'),
    sRes: document.getElementById('step_result'),
    ov: document.getElementById('ov_scr_55'),
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

// Блокування вимкнення екрану
async function lock() { try { if('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch(e){} }
function unlock() { if(wakeLock) { wakeLock.release(); wakeLock = null; } }

// Перемикання табів
function setTab(m) {
    cMode = m;
    document.getElementById('t_auto').classList.toggle('active_t', m==='auto');
    document.getElementById('t_manual').classList.toggle('active_t', m==='manual');
    document.getElementById('m_cntrls').classList.toggle('hidden_node', m==='auto');
    document.getElementById('a_info').classList.toggle('hidden_node', m==='manual');
    draw();
}
document.getElementById('t_auto').onclick = () => setTab('auto');
document.getElementById('t_manual').onclick = () => setTab('manual');

// Оновлення тексту повзунків
dom.dur.oninput = () => { dom.txtDur.innerText = dom.dur.value + " сек"; draw(); };
dom.db.oninput = () => { dom.txtDb.innerText = dom.db.value + " dB"; draw(); };

// Малювання хвилі
function draw() {
    if(!aBuffer) return;
    const ctx = dom.cvs.getContext('2d');
    dom.cvs.width = dom.cvs.clientWidth * 2; // для чіткості на Retina
    dom.cvs.height = dom.cvs.clientHeight * 2;
    const w = dom.cvs.width, h = dom.cvs.height;
    ctx.clearRect(0,0,w,h);
    
    const step = Math.ceil(aBuffer.length/w);
    ctx.fillStyle = "#2b6cff";
    for(let i=0; i<w; i++){
        let min=1, max=-1;
        for(let j=0; j<step; j++){
            const v = aBuffer[(i*step)+j]||0;
            if(v<min) min=v; if(v>max) max=v;
        }
        ctx.fillRect(i, (1+min)*(h/2), 2, Math.max(2,(max-min)*(h/2)));
    }

    // Підсвітка зон видалення
    const p = cMode==='auto' ? getAutoP() : {db: parseFloat(dom.db.value), dur: parseFloat(dom.dur.value)};
    const lim = Math.pow(10, p.db/20);
    const bT = 1024/sRate;
    
    ctx.fillStyle = "rgba(255, 0, 0, 0.3)";
    let st = null;
    cRMS.forEach((v, i) => {
        const t = i * bT;
        if (v < lim) { if (st === null) st = t; }
        else {
            if (st !== null && (t - st) >= p.dur) {
                const x1 = (st / aDur) * w;
                const x2 = (t / aDur) * w;
                ctx.fillRect(x1, 0, x2-x1, h);
            }
            st = null;
        }
    });
}

// Завантаження файлу
dom.fInp.onchange = async (e) => {
    const file = e.target.files[0]; 
    if(!file) return;

    dom.ov.style.display = 'flex';
    dom.ovPct.innerText = "...";
    
    // ФІКС ДЛЯ IPHONE: Створюємо контекст всередині події
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const aCtx = new AudioContext();
    
    try {
        if (aCtx.state === 'suspended') await aCtx.resume();

        const arrayBuf = await file.arrayBuffer();
        const dec = await aCtx.decodeAudioData(arrayBuf);
        
        aBuffer = dec.getChannelData(0); 
        aDur = dec.duration; 
        sRate = dec.sampleRate;

        // Рахуємо RMS (гучність) блоками
        const s = 1024; cRMS = [];
        for (let i = 0; i < aBuffer.length; i += s) {
            let sum = 0; 
            for (let j = 0; j < s; j++) { 
                const v = aBuffer[i+j]||0; 
                sum += v*v; 
            }
            cRMS.push(Math.sqrt(sum/s));
        }

        dom.sFile.classList.add('hidden_node');
        dom.sEdit.classList.remove('hidden_node');
        draw();
        dom.ov.style.display = 'none';
    } catch (err) { 
        console.error(err);
        alert("Помилка читання аудіо. Переконайтеся, що файл не пошкоджено."); 
        dom.ov.style.display = 'none'; 
    }
};

function getAutoP() {
    const s = [...cRMS].sort((a,b)=>a-b);
    const n = s[Math.floor(s.length*0.15)] || 0.001;
    let db = Math.round(20 * Math.log10(n + 1e-6) + 7);
    return { 
        db: Math.min(-28, Math.max(-45, db)), 
        dur: aDur > 60 ? 0.55 : 0.4 
    };
}

// Запуск обробки
dom.btnGo.onclick = async () => {
    const file = dom.fInp.files[0]; 
    if(!file) return;

    dom.btnGo.disabled = true;
    await lock();
    dom.ov.style.display = 'flex';
    
    if(!isLoaded) {
        dom.ovPct.innerText = "FFMPEG";
        await ffmpeg.load(); 
        isLoaded = true; 
    }
    
    const p = cMode==='auto' ? getAutoP() : {db: parseFloat(dom.db.value), dur: parseFloat(dom.dur.value)};
    const lim = Math.pow(10, p.db/20);
    const sil = []; let st = null; const bT = 1024/sRate;

    cRMS.forEach((v, i) => {
        const t = i * bT;
        if (v < lim) { if (st === null) st = t; }
        else if (st !== null) { 
            if (t - st >= p.dur) sil.push({st, en: t}); 
            st = null; 
        }
    });

    // Формуємо сегменти для збереження
    const segs = []; let prev = 0, PAD = 0.08;
    sil.forEach(s => {
        if(s.st > prev) segs.push({s: Math.max(0, prev-(prev===0?0:PAD)), e: s.st+PAD});
        prev = s.en;
    });
    if(prev < aDur) segs.push({s: Math.max(0, prev-PAD), e: aDur});
    
    const tOut = segs.reduce((a,s)=>a+(s.e-s.s), 0);
    
    // Запис у віртуальну файлову систему
    ffmpeg.FS("writeFile", "in.mp4", await fetchFile(file));

    // Будуємо складний фільтр
    let f = "", c = "";
    segs.forEach((s, i) => {
        f += `[0:v]trim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
        f += `[0:a]atrim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
        c += `[v${i}][a${i}]`;
    });
    f += `${c}concat=n=${segs.length}:v=1:a=1[v][a]`;

    // Відстеження прогресу
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
        // Оптимізовано для iPhone (ultrafast + crf 28)
        await ffmpeg.run(
            "-i", "in.mp4", 
            "-filter_complex", f, 
            "-map", "[v]", "-map", "[a]", 
            "-c:v", "libx264", 
            "-preset", "ultrafast", 
            "-crf", "28", 
            "-c:a", "aac", 
            "out.mp4"
        );

        const data = ffmpeg.FS("readFile", "out.mp4");
        const url = URL.createObjectURL(new Blob([data.buffer], {type:"video/mp4"}));
        
        dom.vPre.src = url; 
        dom.dl.href = url; 
        
        dom.ov.style.display = 'none';
        dom.sEdit.classList.add('hidden_node');
        dom.sRes.classList.remove('hidden_node');
        
        // Очистка пам'яті
        ffmpeg.FS("unlink", "in.mp4");
        ffmpeg.FS("unlink", "out.mp4");
    } catch (e) { 
        alert("Помилка обробки. Спробуйте коротше відео."); 
        dom.ov.style.display = 'none'; 
    } finally { 
        dom.btnGo.disabled = false; 
        unlock(); 
    }
};

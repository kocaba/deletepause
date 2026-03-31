const { createFFmpeg, fetchFile } = FFmpeg;
// Важливо: для iPhone краще використовувати стабільну версію з CDN
const ffmpeg = createFFmpeg({ log: true });

let aBuffer = null, cRMS = [], aDur = 0, sRate = 44100, isLoaded = false;
let wakeLock = null;

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
    dl: document.getElementById('dl_btn_99')
};

// Блокування сну екрана (важливо для довгих відео на мобільних)
async function lock() { try { if('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch(e){} }

dom.fInp.onchange = async (e) => {
    const file = e.target.files[0]; if(!file) return;
    
    dom.ov.style.display = 'flex';
    dom.ovPct.innerText = "Аналіз...";

    // Створюємо аудіо контекст після кліку (вимога iOS)
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const aCtx = new AudioContext();
    
    try {
        const arrayBuf = await file.arrayBuffer();
        const dec = await aCtx.decodeAudioData(arrayBuf);
        
        aBuffer = dec.getChannelData(0); 
        aDur = dec.duration; 
        sRate = dec.sampleRate;

        // Швидкий розрахунок RMS для візуалізації
        const s = 2048; cRMS = [];
        for (let i = 0; i < aBuffer.length; i += s) {
            let sum = 0; for (let j = 0; j < s; j++) { const v = aBuffer[i+j]||0; sum += v*v; }
            cRMS.push(Math.sqrt(sum/s));
        }

        dom.sFile.classList.add('hidden_node');
        dom.sEdit.classList.remove('hidden_node');
        draw();
        dom.ov.style.display = 'none';
    } catch (err) { 
        alert("iPhone не зміг обробити цей формат. Спробуйте інше відео."); 
        dom.ov.style.display = 'none'; 
    }
};

function draw() {
    const ctx = dom.cvs.getContext('2d');
    dom.cvs.width = dom.cvs.clientWidth; dom.cvs.height = dom.cvs.clientHeight;
    const w = dom.cvs.width, h = dom.cvs.height;
    ctx.fillStyle = "#2b6cff";
    const step = Math.ceil(aBuffer.length / w);
    for(let i=0; i<w; i++){
        let max=0;
        for(let j=0; j<step; j++) {
            const v = Math.abs(aBuffer[(i*step)+j]||0);
            if(v > max) max = v;
        }
        ctx.fillRect(i, h/2 - (max*h/2), 1, max*h);
    }
}

dom.btnGo.onclick = async () => {
    const file = dom.fInp.files[0]; if(!file) return;
    dom.btnGo.disabled = true;
    await lock();
    dom.ov.style.display = 'flex';

    if(!isLoaded) { 
        dom.ovPct.innerText = "Завантаження ядра...";
        await ffmpeg.load(); 
        isLoaded = true; 
    }

    // Параметри тиші (автоматичні)
    const lim = 0.02; // Поріг чутливості
    const minDur = 0.5; // Мінімальна тиша
    const sil = []; let st = null; const bT = 2048/sRate;

    cRMS.forEach((v, i) => {
        const t = i * bT;
        if (v < lim) { if (st === null) st = t; }
        else if (st !== null) { if (t - st >= minDur) sil.push({st, en: t}); st = null; }
    });

    const segs = []; let prev = 0, PAD = 0.1;
    sil.forEach(s => {
        if(s.st > prev) segs.push({s: Math.max(0, prev-(prev===0?0:PAD)), e: s.st+PAD});
        prev = s.en;
    });
    if(prev < aDur) segs.push({s: Math.max(0, prev-PAD), e: aDur});

    const tOut = segs.reduce((a,s)=>a+(s.e-s.s), 0);
    
    ffmpeg.FS("writeFile", "in.mp4", await fetchFile(file));

    // Складний фільтр для склейки
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
        // Використовуємо налаштування для максимальної сумісності з iOS (h264, yuv420p)
        await ffmpeg.run(
            "-i", "in.mp4", 
            "-filter_complex", f, 
            "-map", "[v]", "-map", "[a]", 
            "-c:v", "libx264", 
            "-pix_fmt", "yuv420p",
            "-profile:v", "baseline",
            "-level", "3.0",
            "-preset", "ultrafast", 
            "-crf", "28",
            "out.mp4"
        );

        const data = ffmpeg.FS("readFile", "out.mp4");
        const url = URL.createObjectURL(new Blob([data.buffer], {type:"video/mp4"}));
        
        dom.vPre.src = url; 
        dom.dl.href = url; 
        dom.dl.style.display = "block";
        dom.ov.style.display = 'none';
        dom.sEdit.classList.add('hidden_node');
        dom.sRes.classList.remove('hidden_node');
    } catch (e) { 
        alert("Помилка рендерингу. Можливо, файл занадто великий для пам'яті браузера."); 
        dom.ov.style.display = 'none'; 
    } finally { 
        dom.btnGo.disabled = false; 
    }
};

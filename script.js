const { createFFmpeg, fetchFile } = FFmpeg;

// Спеціальна конфігурація для iPhone (якщо сервер не підтримує SharedArrayBuffer)
const ffmpeg = createFFmpeg({ 
    log: true, 
    corePath: './ffmpeg/ffmpeg-core.js',
    mainName: 'main' 
});

let aBuffer = null, cRMS = [], aDur = 0, sRate = 44100, isLoaded = false, cMode = 'auto';

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
    db: document.getElementById('val_db'),
    txtDb: document.getElementById('txt_db')
};

// Перемикання табів
document.getElementById('t_auto').onclick = () => {
    cMode = 'auto';
    document.getElementById('t_auto').classList.add('active_t');
    document.getElementById('t_manual').classList.remove('active_t');
    document.getElementById('m_cntrls').classList.add('hidden_node');
};
document.getElementById('t_manual').onclick = () => {
    cMode = 'manual';
    document.getElementById('t_manual').classList.add('active_t');
    document.getElementById('t_auto').classList.remove('active_t');
    document.getElementById('m_cntrls').classList.remove('hidden_node');
};

dom.db.oninput = () => dom.txtDb.innerText = dom.db.value;

// Візуалізація
function draw() {
    const ctx = dom.cvs.getContext('2d');
    dom.cvs.width = dom.cvs.clientWidth;
    dom.cvs.height = dom.cvs.clientHeight;
    if(!aBuffer) return;
    const step = Math.ceil(aBuffer.length / dom.cvs.width);
    ctx.fillStyle = "#2b6cff";
    for(let i=0; i < dom.cvs.width; i++) {
        let max = 0;
        for(let j=0; j<step; j++) {
            const v = Math.abs(aBuffer[(i*step)+j] || 0);
            if(v > max) max = v;
        }
        ctx.fillRect(i, dom.cvs.height/2 - (max * dom.cvs.height/2), 1, max * dom.cvs.height);
    }
}

// Завантаження файлу
dom.fInp.onchange = async (e) => {
    const file = e.target.files[0];
    if(!file) return;

    dom.ov.style.display = 'flex';
    dom.ovPct.innerText = "Завантаження...";

    try {
        const aCtx = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuf = await file.arrayBuffer();
        const dec = await aCtx.decodeAudioData(arrayBuf);
        
        aBuffer = dec.getChannelData(0);
        aDur = dec.duration;
        sRate = dec.sampleRate;

        // Швидкий розрахунок RMS
        cRMS = [];
        const blockSize = 1024;
        for (let i = 0; i < aBuffer.length; i += blockSize) {
            let sum = 0;
            for (let j = 0; j < blockSize; j++) {
                const v = aBuffer[i+j] || 0;
                sum += v*v;
            }
            cRMS.push(Math.sqrt(sum/blockSize));
        }

        dom.sFile.classList.add('hidden_node');
        dom.sEdit.classList.remove('hidden_node');
        draw();
        dom.ov.style.display = 'none';
    } catch (err) {
        alert("Помилка при читанні аудіо. Спробуйте інший файл.");
        dom.ov.style.display = 'none';
    }
};

// Обробка
dom.btnGo.onclick = async () => {
    const file = dom.fInp.files[0];
    dom.btnGo.disabled = true;
    dom.ov.style.display = 'flex';

    if(!isLoaded) {
        try {
            await ffmpeg.load();
            isLoaded = true;
        } catch (e) {
            alert("FFmpeg не зміг завантажитись. Перевірте з'єднання або налаштування сервера.");
            dom.ov.style.display = 'none';
            dom.btnGo.disabled = false;
            return;
        }
    }

    const thresholdDB = cMode === 'auto' ? -35 : parseFloat(dom.db.value);
    const minSilence = 0.5;
    const limit = Math.pow(10, thresholdDB/20);
    const sil = [];
    let st = null;
    const blockTime = 1024/sRate;

    cRMS.forEach((v, i) => {
        const t = i * blockTime;
        if (v < limit) { if (st === null) st = t; }
        else if (st !== null) { 
            if (t - st >= minSilence) sil.push({st, en: t}); 
            st = null; 
        }
    });

    // Формуємо сегменти
    const segs = [];
    let prev = 0, PAD = 0.1;
    sil.forEach(s => {
        if(s.st > prev) segs.push({s: Math.max(0, prev - (prev===0?0:PAD)), e: s.st + PAD});
        prev = s.en;
    });
    if(prev < aDur) segs.push({s: Math.max(0, prev - PAD), e: aDur});

    const tOut = segs.reduce((a,s) => a + (s.e - s.s), 0);
    
    ffmpeg.FS("writeFile", "in.mp4", await fetchFile(file));

    let filter = "";
    let concat = "";
    segs.forEach((s, i) => {
        filter += `[0:v]trim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
        filter += `[0:a]atrim=start=${s.s.toFixed(3)}:end=${s.e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
        concat += `[v${i}][a${i}]`;
    });
    filter += `${concat}concat=n=${segs.length}:v=1:a=1[v][a]`;

    ffmpeg.setLogger(({message}) => {
        const m = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if(m) {
            const t = parseInt(m[1])*3600 + parseInt(m[2])*60 + parseFloat(m[3]);
            const pct = Math.min(99, (t/tOut)*100);
            dom.bar.style.width = pct + "%";
            dom.ovPct.innerText = pct.toFixed(0) + "%";
        }
    });

    try {
        // Оптимізовано для мобільних: ultrafast та crf 28 (менше навантаження)
        await ffmpeg.run("-i", "in.mp4", "-filter_complex", filter, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "out.mp4");
        
        const data = ffmpeg.FS("readFile", "out.mp4");
        const blob = new Blob([data.buffer], {type:"video/mp4"});
        const url = URL.createObjectURL(blob);
        
        dom.vPre.src = url;
        dom.dl.href = url;
        dom.dl.style.display = "block";
        dom.ov.style.display = 'none';
        dom.sEdit.classList.add('hidden_node');
        dom.sRes.classList.remove('hidden_node');
        
        // Очищення пам'яті FFmpeg
        ffmpeg.FS("unlink", "in.mp4");
        ffmpeg.FS("unlink", "out.mp4");
    } catch (e) {
        alert("Помилка при обробці відео.");
        dom.ov.style.display = 'none';
    } finally {
        dom.btnGo.disabled = false;
    }
};

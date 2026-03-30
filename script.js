const { createFFmpeg, fetchFile } = FFmpeg;

// Ініціалізація з налаштуваннями для мобільних
const ffmpeg = createFFmpeg({
    log: true,
    corePath: './ffmpeg/ffmpeg-core.js'
});

const dom = {
    input: document.getElementById('file-input'),
    drop: document.getElementById('drop-zone'),
    log: document.getElementById('status-log'),
    s1: document.getElementById('step-1'),
    s2: document.getElementById('step-2'),
    s3: document.getElementById('step-3'),
    ov: document.getElementById('ov-loading'),
    msg: document.getElementById('loader-msg'),
    pct: document.getElementById('loader-pct'),
    canvas: document.getElementById('wav-canvas'),
    run: document.getElementById('process-btn'),
    video: document.getElementById('result-video'),
    save: document.getElementById('save-btn')
};

let audioData = null;
let duration = 0;
let ffmpegReady = false;

// Функція для логів на екрані
function printLog(msg) {
    dom.log.innerText += `\n> ${msg}`;
}

// 1. Обробка вибору файлу
dom.drop.onclick = () => dom.input.click();

dom.input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    dom.ov.style.display = 'flex';
    dom.msg.innerText = "Зчитуємо звук...";
    printLog(`Обрано: ${file.name}`);

    try {
        // Пробуджуємо аудіо для iOS/Android
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const aCtx = new AudioContext();
        
        const arrayBuffer = await file.arrayBuffer();
        
        // Використовуємо Callback-метод (найстабільніший для Safari)
        aCtx.decodeAudioData(arrayBuffer, (decoded) => {
            audioData = decoded.getChannelData(0);
            duration = decoded.duration;
            
            drawWave(audioData);
            
            dom.s1.classList.add('hidden');
            dom.s2.classList.remove('hidden');
            dom.ov.style.display = 'none';
            printLog("Аудіо готове.");
        }, (err) => {
            printLog("Помилка декодування: Перевірте формат відео.");
            dom.ov.style.display = 'none';
        });

    } catch (err) {
        printLog("Критична помилка: " + err.message);
        dom.ov.style.display = 'none';
    }
};

// 2. Малювання хвилі
function drawWave(data) {
    const ctx = dom.canvas.getContext('2d');
    const w = dom.canvas.width = dom.canvas.clientWidth * 2;
    const h = dom.canvas.height = dom.canvas.clientHeight * 2;
    ctx.fillStyle = "#007aff";
    
    const step = Math.ceil(data.length / w);
    for(let i=0; i<w; i++) {
        let max = 0;
        for(let j=0; j<step; j++) {
            let v = Math.abs(data[i*step + j]);
            if(v > max) max = v;
        }
        ctx.fillRect(i, h/2 - (max*h/2), 2, max*h);
    }
}

// 3. Запуск обробки
dom.run.onclick = async () => {
    dom.ov.style.display = 'flex';
    
    if (!ffmpegReady) {
        dom.msg.innerText = "Завантаження ядра FFmpeg (це може тривати 10-20 сек)...";
        try {
            await ffmpeg.load();
            ffmpegReady = true;
        } catch (e) {
            printLog("FFmpeg не завантажився. Причина: Cross-Origin Isolation.");
            dom.ov.style.display = 'none';
            return;
        }
    }

    const file = dom.input.files[0];
    dom.msg.innerText = "Монтаж відео...";
    
    ffmpeg.FS('writeFile', 'input.mp4', await fetchFile(file));

    // Налаштування для прогресу
    ffmpeg.setLogger(({ message }) => {
        if (message.includes('time=')) {
            printLog(message); // Виводимо прогрес у консоль
        }
    });

    try {
        // Команда для вирізання (тестова: копіює перші 15 сек для швидкості)
        // Для реального вирізання тиші тут має бути ваш filter_complex
        await ffmpeg.run('-i', 'input.mp4', '-t', '15', '-c', 'copy', 'output.mp4');

        const data = ffmpeg.FS('readFile', 'output.mp4');
        const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
        
        dom.video.src = url;
        dom.save.onclick = () => {
            const a = document.createElement('a');
            a.href = url;
            a.download = "no_silence.mp4";
            a.click();
        };

        dom.s2.classList.add('hidden');
        dom.s3.classList.remove('hidden');
        dom.ov.style.display = 'none';
    } catch (e) {
        printLog("Помилка під час обробки: " + e.message);
        dom.ov.style.display = 'none';
    }
};

// =========================
// INIT FFMPEG
// =========================

// Подключаем FFmpeg (браузерную версию)
const { createFFmpeg, fetchFile } = FFmpeg;

// Создаём экземпляр ffmpeg
// log: true -> включает вывод логов (ВАЖНО для поиска тишины)
const ffmpeg = createFFmpeg({ log: true });

// Флаг: загружен ли ffmpeg
let loaded = false;

// Здесь будут храниться ВСЕ логи ffmpeg
let logs = [];


// =========================
// STATE (состояние приложения)
// =========================

// Массив PCM аудио (сырые аудио-сэмплы)
let audioData = null;

// Длительность аудио (в секундах)
let audioDuration = 0;

// Частота дискретизации (например 44100 Hz)
let sampleRate = 44100;


// =========================
// STATUS (обновление текста UI)
// =========================

// Просто вывод статуса пользователю
function setStatus(text) {
  document.getElementById("progress").innerText = text;
}


// =========================
// LOGGER (перехват логов ffmpeg)
// =========================

// Каждый лог от ffmpeg мы сохраняем в массив
ffmpeg.setLogger(({ message }) => {
  logs.push(message);
});


// =========================
// LOAD FFMPEG
// =========================

// Загружает ffmpeg (один раз)
async function loadFFmpeg() {
  if (!loaded) {
    setStatus("Загрузка движка...");
    await ffmpeg.load(); // загружается wasm
    loaded = true;
  }
}


// =========================
// LOAD AUDIO (ключевой момент анализа)
// =========================

// Здесь мы:
// 1. Декодируем аудио из видео
// 2. Получаем PCM данные (сырые волны)
async function loadAudioData(file) {

  // Создаём AudioContext (Web Audio API)
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Иногда браузер требует "разбудить" аудио
  await audioCtx.resume();

  // Читаем файл как ArrayBuffer
  const buffer = await file.arrayBuffer();

  // Декодируем аудио (очень важно!)
  const decoded = await audioCtx.decodeAudioData(buffer);

  // Берём только 1 канал (моно)
  audioData = decoded.getChannelData(0);

  // Длительность
  audioDuration = decoded.duration;

  // Частота
  sampleRate = decoded.sampleRate;
}


// =========================
// DETECT SILENCE (анализ ТИШИНЫ вручную)
// =========================

// Здесь происходит ЛОКАЛЬНЫЙ анализ аудио (без ffmpeg)
function detectSilencePCM(thresholdDb, minDuration) {

  // Переводим dB в линейное значение
  const threshold = Math.pow(10, thresholdDb / 20);

  // Размер окна (чем больше — тем быстрее, но грубее)
  const windowSize = 1024;

  const silences = [];

  let silenceStart = null;

  // Идём по аудио чанками
  for (let i = 0; i < audioData.length; i += windowSize) {

    let sum = 0;

    // Считаем RMS (громкость)
    for (let j = 0; j < windowSize; j++) {
      const sample = audioData[i + j] || 0;
      sum += sample * sample;
    }

    const rms = Math.sqrt(sum / windowSize);

    // Перевод позиции в секунды
    const time = i / sampleRate;

    // Если громкость ниже порога -> тишина
    if (rms < threshold) {
      if (silenceStart === null) silenceStart = time;
    } else {
      // Если вышли из тишины
      if (silenceStart !== null) {
        const dur = time - silenceStart;

        // Если тишина достаточно длинная — сохраняем
        if (dur >= minDuration) {
          silences.push({ start: silenceStart, end: time });
        }

        silenceStart = null;
      }
    }
  }

  return silences;
}


// =========================
// DRAW WAVEFORM + SILENCE (визуализация)
// =========================

function drawWaveform() {

  const canvas = document.getElementById("waveform");
  const ctx = canvas.getContext("2d");

  // Подгоняем размер canvas под экран
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  const width = canvas.width;
  const height = canvas.height;

  // Сколько сэмплов на 1 пиксель
  const step = Math.ceil(audioData.length / width);

  const amp = height / 2;

  ctx.clearRect(0, 0, width, height);

  // =====================
  // РИСУЕМ ВОЛНУ
  // =====================

  ctx.fillStyle = "#888";

  for (let i = 0; i < width; i++) {

    let min = 1;
    let max = -1;

    // Находим min/max в сегменте
    for (let j = 0; j < step; j++) {
      const val = audioData[(i * step) + j] || 0;
      if (val < min) min = val;
      if (val > max) max = val;
    }

    // Рисуем вертикальную линию (waveform)
    ctx.fillRect(
      i,
      (1 + min) * amp,
      1,
      Math.max(1, (max - min) * amp)
    );
  }

  // =====================
  // ПОДСВЕТКА ТИШИНЫ
  // =====================

  const threshold = parseFloat(document.getElementById("threshold").value);
  const duration = parseFloat(document.getElementById("duration").value);

  // Используем наш алгоритм
  const silences = detectSilencePCM(threshold, duration);

  // Красный оверлей
  ctx.fillStyle = "rgba(255,0,0,0.3)";

  silences.forEach(s => {
    const x1 = (s.start / audioDuration) * width;
    const x2 = (s.end / audioDuration) * width;

    ctx.fillRect(x1, 0, x2 - x1, height);
  });
}


// =========================
// FILE LOAD (когда выбрали видео)
// =========================

document.getElementById("fileInput").onchange = async (e) => {

  const file = e.target.files[0];
  if (!file) return;

  // Показываем видео
  document.getElementById("preview").src =
    URL.createObjectURL(file);

  setStatus("Анализ аудио...");

  // 🔥 КЛЮЧ: анализируем аудио
  await loadAudioData(file);

  // Рисуем waveform
  drawWaveform();

  setStatus("Готово к обработке");
};


// =========================
// LIVE UPDATE (движение ползунков)
// =========================

document.getElementById("threshold").oninput = () => {
  if (audioData) drawWaveform();
};

document.getElementById("duration").oninput = () => {
  if (audioData) drawWaveform();
};


// =========================
// RESIZE (перерисовка)
// =========================

window.addEventListener("resize", () => {
  if (audioData) drawWaveform();
});


// =========================
// PARSE SILENCE (разбор логов ffmpeg)
// =========================

// ffmpeg пишет строки типа:
// silence_start: 1.23
// silence_end: 3.45

function parseSilence(logs) {

  const silences = [];
  let current = null;

  logs.forEach(line => {

    const start = line.match(/silence_start: (\d+\.?\d*)/);
    const end = line.match(/silence_end: (\d+\.?\d*)/);

    if (start) current = { start: parseFloat(start[1]) };

    if (end && current) {
      current.end = parseFloat(end[1]);
      silences.push(current);
      current = null;
    }
  });

  return silences;
}


// =========================
// GET DURATION (из логов)
// =========================

function getDuration(logs) {

  for (const line of logs) {
    const m = line.match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);

    if (m) {
      return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    }
  }

  return 0;
}


// =========================
// BUILD SEGMENTS (главная логика резки)
// =========================

// Здесь мы делаем ОБРАТНОЕ:
// из тишины -> получаем куски С ЗВУКОМ

function buildSegments(silences, duration) {

  const segments = [];
  let prev = 0;

  silences.forEach(s => {

    // участок ДО тишины = нужный сегмент
    if (s.start > prev) {
      segments.push({ start: prev, end: s.start });
    }

    prev = s.end;
  });

  // хвост
  if (prev < duration) {
    segments.push({ start: prev, end: duration });
  }

  return segments;
}


// =========================
// MAIN PROCESS (главная кнопка)
// =========================

document.getElementById("processBtn").onclick = async () => {

  const file = document.getElementById("fileInput").files[0];
  if (!file) return alert("Выбери файл");

  await loadFFmpeg();

  logs = [];

  setStatus("Загрузка файла...");

  // Загружаем видео в виртуальную FS ffmpeg
  ffmpeg.FS("writeFile", "input.mp4", await fetchFile(file));

  const duration = document.getElementById("duration").value;
  const threshold = document.getElementById("threshold").value;

  setStatus("Поиск тишины...");

  // 🔥 ВОТ ГДЕ FFMPEG ИЩЕТ ТИШИНУ
  await ffmpeg.run(
    "-i", "input.mp4",
    "-af", `silencedetect=noise=${threshold}dB:d=${duration}`,
    "-f", "null",
    "-"
  );

  // Парсим результат
  const silences = parseSilence(logs);

  if (!silences.length) {
    setStatus("Тишина не найдена");
    return;
  }

  const totalDuration = getDuration(logs);

  // Получаем сегменты БЕЗ тишины
  let segments = buildSegments(silences, totalDuration);

  // Немного расширяем сегменты (чтобы не резало слова)
  const PAD = 0.08;

  segments = segments.map(s => ({
    start: Math.max(0, s.start - PAD),
    end: s.end + PAD
  }));

  setStatus(`Найдено сегментов: ${segments.length}`);

  // =====================
  // ВЫРЕЗАНИЕ ВИДЕО
  // =====================

  for (let i = 0; i < segments.length; i++) {

    const s = segments[i];

    setStatus(`Сегмент ${i + 1} / ${segments.length}`);

    // 🔥 ВОТ ГДЕ РЕЖЕТСЯ ВИДЕО
    await ffmpeg.run(
      "-ss", String(s.start),   // старт
      "-to", String(s.end),     // конец
      "-i", "input.mp4",
      "-c:v", "libx264",
      "-c:a", "aac",
      `part${i}.mp4`
    );
  }

  // =====================
  // СКЛЕЙКА ОБРАТНО
  // =====================

  setStatus("Склейка...");

  let concatList = "";

  for (let i = 0; i < segments.length; i++) {
    concatList += `file part${i}.mp4\n`;
  }

  ffmpeg.FS(
    "writeFile",
    "list.txt",
    new TextEncoder().encode(concatList)
  );

  await ffmpeg.run(
    "-f", "concat",
    "-safe", "0",
    "-i", "list.txt",
    "-c:v", "libx264",
    "-c:a", "aac",
    "output.mp4"
  );

  setStatus("Готово");

  // Получаем результат
  const data = ffmpeg.FS("readFile", "output.mp4");

  const url = URL.createObjectURL(
    new Blob([data.buffer], { type: "video/mp4" })
  );

  // Показываем видео
  document.getElementById("preview").src = url;

  // Кнопка скачать
  const btn = document.getElementById("downloadBtn");
  btn.href = url;
  btn.style.display = "inline";
};

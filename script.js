// =========================
// INIT FFMPEG
// =========================
const { createFFmpeg, fetchFile } = FFmpeg;

const ffmpeg = createFFmpeg({ log: true });

let loaded = false;
let logs = [];

// Удобная функция для статуса
function setStatus(text) {
  document.getElementById("progress").innerText = text;
}

// Логи ffmpeg (для silencedetect)
ffmpeg.setLogger(({ message }) => {
  logs.push(message);
});

// ⚠️ ОТКЛЮЧАЕМ стандартный ratio (он тебе больше не нужен)
// ffmpeg.setProgress — больше не используем

async function loadFFmpeg() {
  if (!loaded) {
    setStatus("Загрузка движка...");
    await ffmpeg.load();
    loaded = true;
  }
}

// =========================
// WAVEFORM (БЕЗ FFMPEG)
// =========================
async function drawWaveform(file) {
  const canvas = document.getElementById("waveform");
  const ctx = canvas.getContext("2d");

  const audioCtx = new AudioContext();

  // читаем файл как ArrayBuffer
  const arrayBuffer = await file.arrayBuffer();

  // декодируем аудио
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  const data = audioBuffer.getChannelData(0); // один канал
  const step = Math.ceil(data.length / canvas.width);

  const amp = canvas.height / 2;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // рисуем waveform
  for (let i = 0; i < canvas.width; i++) {
    let min = 1.0;
    let max = -1.0;

    for (let j = 0; j < step; j++) {
      const datum = data[(i * step) + j];
      if (datum < min) min = datum;
      if (datum > max) max = datum;
    }

    ctx.fillRect(
      i,
      (1 + min) * amp,
      1,
      Math.max(1, (max - min) * amp)
    );
  }
}

// =========================
// PREVIEW + WAVEFORM
// =========================
document.getElementById("fileInput").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // видео preview
  document.getElementById("preview").src =
    URL.createObjectURL(file);

  // waveform
  setStatus("Анализ аудио...");
  await drawWaveform(file);
  setStatus("Готово к обработке");
};

// =========================
// PARSE SILENCE
// =========================
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
// GET DURATION
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
// BUILD SEGMENTS
// =========================
function buildSegments(silences, duration) {
  const segments = [];
  let prev = 0;

  silences.forEach(s => {
    if (s.start > prev) {
      segments.push({ start: prev, end: s.start });
    }
    prev = s.end;
  });

  if (prev < duration) {
    segments.push({ start: prev, end: duration });
  }

  return segments;
}

// =========================
// MAIN PROCESS
// =========================
document.getElementById("processBtn").onclick = async () => {
  const file = document.getElementById("fileInput").files[0];
  if (!file) return alert("Выбери файл");

  await loadFFmpeg();

  logs = [];

  setStatus("Загрузка файла...");
  ffmpeg.FS("writeFile", "input.mp4", await fetchFile(file));

  const duration = document.getElementById("duration").value;
  const threshold = document.getElementById("threshold").value;

  // =========================
  // 1. DETECT SILENCE
  // =========================
  setStatus("Поиск тишины...");

  await ffmpeg.run(
    "-i", "input.mp4",
    "-af", `silencedetect=noise=${threshold}dB:d=${duration}`,
    "-f", "null",
    "-"
  );

  const silences = parseSilence(logs);

  if (!silences.length) {
    setStatus("Тишина не найдена");
    return;
  }

  const totalDuration = getDuration(logs);

  let segments = buildSegments(silences, totalDuration);

  // padding
  const PAD = 0.08;

  segments = segments.map(s => ({
    start: Math.max(0, s.start - PAD),
    end: s.end + PAD
  }));

  setStatus(`Найдено сегментов: ${segments.length}`);

  // =========================
  // CUT
  // =========================
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];

    setStatus(`Обработка сегмента ${i + 1} из ${segments.length}`);

    await ffmpeg.run(
      "-ss", String(s.start),
      "-to", String(s.end),
      "-i", "input.mp4",
      "-c:v", "libx264",
      "-c:a", "aac",
      `part${i}.mp4`
    );
  }

  // =========================
  // CONCAT LIST
  // =========================
  setStatus("Подготовка склейки...");

  let concatList = "";

  for (let i = 0; i < segments.length; i++) {
    concatList += `file part${i}.mp4\n`;
  }

  ffmpeg.FS(
    "writeFile",
    "list.txt",
    new TextEncoder().encode(concatList)
  );

  // =========================
  // MERGE
  // =========================
  setStatus("Склейка сегментов...");

  await ffmpeg.run(
    "-f", "concat",
    "-safe", "0",
    "-i", "list.txt",
    "-c:v", "libx264",
    "-c:a", "aac",
    "output.mp4"
  );

  // =========================
  // RESULT
  // =========================
  setStatus("Готово");

  const data = ffmpeg.FS("readFile", "output.mp4");

  const url = URL.createObjectURL(
    new Blob([data.buffer], { type: "video/mp4" })
  );

  document.getElementById("preview").src = url;

  const btn = document.getElementById("downloadBtn");
  btn.href = url;
  btn.style.display = "inline";
};

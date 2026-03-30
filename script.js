// =========================
// INIT FFMPEG
// =========================
const { createFFmpeg, fetchFile } = FFmpeg;

const ffmpeg = createFFmpeg({ log: false });

let loaded = false;


// =========================
// STATE
// =========================
let audioData = null;
let audioDuration = 0;
let sampleRate = 44100;


// =========================
// STATUS
// =========================
function setStatus(text) {
  document.getElementById("progress").innerText = text;
}


// =========================
// LOAD FFMPEG
// =========================
async function loadFFmpeg() {
  if (!loaded) {
    setStatus("Загрузка ffmpeg...");
    await ffmpeg.load();
    loaded = true;
  }
}


// =========================
// LOAD AUDIO (быстро)
// =========================
async function loadAudioData(file) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();

  const buffer = await file.arrayBuffer();
  const decoded = await audioCtx.decodeAudioData(buffer);

  audioData = decoded.getChannelData(0);
  audioDuration = decoded.duration;
  sampleRate = decoded.sampleRate;
}


// =========================
// FAST SILENCE DETECT
// =========================
function detectSilencePCM(thresholdDb, minDuration) {

  const threshold = Math.pow(10, thresholdDb / 20);

  // 🔥 увеличили окно = быстрее
  const windowSize = 4096;

  const silences = [];
  let silenceStart = null;

  for (let i = 0; i < audioData.length; i += windowSize) {

    let sum = 0;

    // 🔥 быстрее чем RMS
    for (let j = 0; j < windowSize; j++) {
      const sample = audioData[i + j] || 0;
      sum += Math.abs(sample);
    }

    const avg = sum / windowSize;
    const time = i / sampleRate;

    if (avg < threshold) {
      if (silenceStart === null) silenceStart = time;
    } else {
      if (silenceStart !== null) {
        const dur = time - silenceStart;

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
// DRAW WAVEFORM
// =========================
function drawWaveform() {

  const canvas = document.getElementById("waveform");
  const ctx = canvas.getContext("2d");

  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  const width = canvas.width;
  const height = canvas.height;

  const step = Math.ceil(audioData.length / width);
  const amp = height / 2;

  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = "#888";

  for (let i = 0; i < width; i++) {

    let min = 1;
    let max = -1;

    for (let j = 0; j < step; j++) {
      const val = audioData[(i * step) + j] || 0;
      if (val < min) min = val;
      if (val > max) max = val;
    }

    ctx.fillRect(
      i,
      (1 + min) * amp,
      1,
      Math.max(1, (max - min) * amp)
    );
  }

  // подсветка тишины
  const threshold = parseFloat(document.getElementById("threshold").value);
  const duration = parseFloat(document.getElementById("duration").value);

  const silences = detectSilencePCM(threshold, duration);

  ctx.fillStyle = "rgba(255,0,0,0.3)";

  silences.forEach(s => {
    const x1 = (s.start / audioDuration) * width;
    const x2 = (s.end / audioDuration) * width;
    ctx.fillRect(x1, 0, x2 - x1, height);
  });
}


// =========================
// FILE LOAD
// =========================
document.getElementById("fileInput").onchange = async (e) => {

  const file = e.target.files[0];
  if (!file) return;

  document.getElementById("preview").src =
    URL.createObjectURL(file);

  setStatus("Анализ аудио...");

  await loadAudioData(file);
  drawWaveform();

  setStatus("Готово");
};


// =========================
// LIVE UPDATE
// =========================
document.getElementById("threshold").oninput = () => {
  if (audioData) drawWaveform();
};

document.getElementById("duration").oninput = () => {
  if (audioData) drawWaveform();
};


// =========================
// MAIN PROCESS (УЛЬТРА БЫСТРО)
// =========================
document.getElementById("processBtn").onclick = async () => {

  const file = document.getElementById("fileInput").files[0];
  if (!file) return alert("Выбери файл");

  await loadFFmpeg();

  setStatus("Анализ тишины...");

  const threshold = parseFloat(document.getElementById("threshold").value);
  const duration = parseFloat(document.getElementById("duration").value);

  // 🔥 используем JS вместо ffmpeg
  const silences = detectSilencePCM(threshold, duration);

  if (!silences.length) {
    setStatus("Тишина не найдена");
    return;
  }

  const segments = buildSegments(silences, audioDuration);

  setStatus(`Сегментов: ${segments.length}`);

  // =====================
  // ЗАГРУЗКА В FFmpeg
  // =====================
  ffmpeg.FS("writeFile", "input.mp4", await fetchFile(file));

  // =====================
  // РЕЗКА (БЕЗ ПЕРЕКОДА)
  // =====================
  for (let i = 0; i < segments.length; i++) {

    const s = segments[i];

    setStatus(`Режем ${i + 1}/${segments.length}`);

    await ffmpeg.run(
      "-ss", String(s.start),
      "-to", String(s.end),
      "-i", "input.mp4",
      "-c", "copy", // 🔥 СУПЕР БЫСТРО
      `part${i}.mp4`
    );
  }

  // =====================
  // СКЛЕЙКА
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
    "-c", "copy",
    "output.mp4"
  );

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

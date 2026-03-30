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
    setStatus("Загрузка движка...");
    await ffmpeg.load();
    loaded = true;
  }
}


// =========================
// LOAD AUDIO
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
// FAST DETECT SILENCE
// =========================
function detectSilencePCM(thresholdDb, minDuration) {

  const threshold = Math.pow(10, thresholdDb / 20);

  // 🔥 ускорили
  const windowSize = 4096;

  const silences = [];
  let silenceStart = null;

  for (let i = 0; i < audioData.length; i += windowSize) {

    let sum = 0;

    for (let j = 0; j < windowSize; j++) {
      const sample = audioData[i + j] || 0;
      sum += sample * sample;
    }

    const rms = Math.sqrt(sum / windowSize);
    const time = i / sampleRate;

    if (rms < threshold) {
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
// MAIN PROCESS (НОВАЯ БЫСТРАЯ ЛОГИКА)
// =========================
document.getElementById("processBtn").onclick = async () => {

  const file = document.getElementById("fileInput").files[0];
  if (!file) return alert("Выбери файл");

  await loadFFmpeg();

  setStatus("Анализ тишины...");

  const threshold = parseFloat(document.getElementById("threshold").value);
  const duration = parseFloat(document.getElementById("duration").value);

  // 🔥 используем быстрый JS анализ
  const silences = detectSilencePCM(threshold, duration);

  if (!silences.length) {
    setStatus("Тишина не найдена");
    return;
  }

  let segments = buildSegments(silences, audioDuration);

  // небольшой padding (чтобы не резало слова)
  const PAD = 0.05;

  segments = segments.map(s => ({
    start: Math.max(0, s.start - PAD),
    end: Math.min(audioDuration, s.end + PAD)
  }));

  setStatus(`Сегментов: ${segments.length}`);

  ffmpeg.FS("writeFile", "input.mp4", await fetchFile(file));

  // =====================
  // СОЗДАЁМ ОДИН FILTER
  // =====================
  let filter = "";
  let concatInputs = "";

  segments.forEach((s, i) => {

    filter += `[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}];`;
    filter += `[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}];`;

    concatInputs += `[v${i}][a${i}]`;
  });

  filter += `${concatInputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`;

  // =====================
  // ОДИН ПРОГОН FFMPEG
  // =====================
  await ffmpeg.run(
    "-i", "input.mp4",
    "-filter_complex", filter,
    "-map", "[outv]",
    "-map", "[outa]",

    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-c:a", "aac",

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

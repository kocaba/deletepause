// =========================
// INIT
// =========================
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ log: false });

let loaded = false;

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
    setStatus("Загрузка...");
    await ffmpeg.load();
    loaded = true;
  }
}


// =========================
// LOAD AUDIO
// =========================
async function loadAudioData(file) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume();

  const buffer = await file.arrayBuffer();
  const decoded = await ctx.decodeAudioData(buffer);

  audioData = decoded.getChannelData(0);
  audioDuration = decoded.duration;
  sampleRate = decoded.sampleRate;
}


// =========================
// DETECT SILENCE
// =========================
function detectSilencePCM(thresholdDb, minDuration) {

  const threshold = Math.pow(10, thresholdDb / 20);
  const windowSize = 2048;

  const silences = [];
  let silenceStart = null;

  for (let i = 0; i < audioData.length; i += windowSize) {

    let sum = 0;

    for (let j = 0; j < windowSize; j++) {
      const s = audioData[i + j] || 0;
      sum += s * s;
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
// BUILD SEGMENTS (что ОСТАВИТЬ)
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
// BUILD SELECT FILTER
// =========================
function buildSelectFilter(segments) {

  // пример:
  // between(t,0,2)+between(t,3,5)

  const parts = segments.map(s => {
    return `between(t,${s.start},${s.end})`;
  });

  return parts.join("+");
}


// =========================
// MAIN PROCESS
// =========================
document.getElementById("processBtn").onclick = async () => {

  const file = document.getElementById("fileInput").files[0];
  if (!file) return alert("Выбери файл");

  await loadFFmpeg();

  setStatus("Анализ...");

  const threshold = parseFloat(document.getElementById("threshold").value);
  const duration = parseFloat(document.getElementById("duration").value);

  const silences = detectSilencePCM(threshold, duration);

  if (!silences.length) {
    setStatus("Тишина не найдена");
    return;
  }

  const segments = buildSegments(silences, audioDuration);

  const selectExpr = buildSelectFilter(segments);

  setStatus("Обработка...");

  ffmpeg.FS("writeFile", "input.mp4", await fetchFile(file));

  await ffmpeg.run(
    "-i", "input.mp4",

    "-vf", `select='${selectExpr}',setpts=N/FRAME_RATE/TB`,
    "-af", `aselect='${selectExpr}',asetpts=N/SR/TB`,

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

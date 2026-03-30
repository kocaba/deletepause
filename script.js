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
// DETECT SILENCE (точнее)
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
// MAIN PROCESS (ИДЕАЛ)
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

  setStatus("Обработка...");

  ffmpeg.FS("writeFile", "input.mp4", await fetchFile(file));

  // =====================
  // СОЗДАЁМ FILTER
  // =====================

  let filter = "";
  let concatInputs = "";

  segments.forEach((s, i) => {

    // видео
    filter += `[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}];`;

    // аудио
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
    "-preset", "ultrafast", // максимально быстро
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

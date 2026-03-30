// =========================
// INIT
// =========================
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ log: true });

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
// DETECT SILENCE (PCM)
// =========================
function detectSilencePCM(thresholdDb, minDuration) {
  const threshold = Math.pow(10, thresholdDb / 20);
  const windowSize = 1024;

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
// BUILD SOUND SEGMENTS
// =========================
function buildSoundSegments(silences, duration) {
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

  // merge близкие сегменты
  const merged = [];
  const GAP = 0.4;

  for (const seg of segments) {
    if (!merged.length) merged.push(seg);
    else {
      const last = merged[merged.length - 1];
      if (seg.start - last.end < GAP) {
        last.end = seg.end;
      } else {
        merged.push(seg);
      }
    }
  }

  return merged;
}

// =========================
// SAFE RUN (copy + fallback)
// =========================
async function safeRun(argsFast, argsSafe) {
  try {
    await ffmpeg.run(...argsFast);
    return true;
  } catch (e) {
    console.warn("fallback encode");
    await ffmpeg.run(...argsSafe);
    return false;
  }
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

  setStatus("Готово");
};

// =========================
// MAIN PROCESS
// =========================
document.getElementById("processBtn").onclick = async () => {
  const file = document.getElementById("fileInput").files[0];
  if (!file) return alert("Выбери файл");

  await loadFFmpeg();

  setStatus("Анализ (быстро)...");

  const threshold = parseFloat(document.getElementById("threshold").value);
  const duration = parseFloat(document.getElementById("duration").value);

  // 🔥 анализ через Web Audio
  const silences = detectSilencePCM(threshold, duration);

  let segments = buildSoundSegments(silences, audioDuration);

  // ограничение для iPhone
  if (segments.length > 40) {
    segments = segments.slice(0, 40);
  }

  const PAD = 0.05;

  segments = segments.map(s => ({
    start: Math.max(0, s.start - PAD),
    end: s.end + PAD
  }));

  setStatus(`Сегментов: ${segments.length}`);

  // =========================
  // LOAD FILE IN FFMPEG
  // =========================
  ffmpeg.FS("writeFile", "input.mp4", await fetchFile(file));

  // =========================
  // CUT
  // =========================
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];

    setStatus(`Сегмент ${i + 1}/${segments.length}`);

    await safeRun(
      [
        "-ss", String(s.start),
        "-to", String(s.end),
        "-i", "input.mp4",
        "-c", "copy",
        `part${i}.mp4`
      ],
      [
        "-ss", String(s.start),
        "-to", String(s.end),
        "-i", "input.mp4",
        "-preset", "ultrafast",
        "-c:v", "libx264",
        "-c:a", "aac",
        `part${i}.mp4`
      ]
    );
  }

  // =========================
  // CONCAT
  // =========================
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

  await safeRun(
    [
      "-f", "concat",
      "-safe", "0",
      "-i", "list.txt",
      "-c", "copy",
      "output.mp4"
    ],
    [
      "-f", "concat",
      "-safe", "0",
      "-i", "list.txt",
      "-preset", "ultrafast",
      "-c:v", "libx264",
      "-c:a", "aac",
      "output.mp4"
    ]
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

  // =========================
  // CLEAN MEMORY
  // =========================
  segments.forEach((_, i) => {
    try { ffmpeg.FS("unlink", `part${i}.mp4`); } catch {}
  });

  try { ffmpeg.FS("unlink", "input.mp4"); } catch {}
  try { ffmpeg.FS("unlink", "list.txt"); } catch {}
};

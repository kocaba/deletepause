// =========================
// INIT
// =========================
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ log: true });

let loaded = false;
let logs = [];

// =========================
// STATUS
// =========================
function setStatus(text) {
  document.getElementById("progress").innerText = text;
}

// =========================
// LOGGER
// =========================
ffmpeg.setLogger(({ message }) => {
  logs.push(message);
});

// =========================
// LOAD
// =========================
async function loadFFmpeg() {
  if (!loaded) {
    setStatus("Загрузка движка...");
    await ffmpeg.load();
    loaded = true;
  }
}

// =========================
// SAFE RUN (fallback)
// =========================
async function safeRun(argsFast, argsSafe) {
  try {
    await ffmpeg.run(...argsFast);
    return "fast";
  } catch (e) {
    console.warn("fallback to safe encode");
    await ffmpeg.run(...argsSafe);
    return "safe";
  }
}

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
// BUILD SEGMENTS (АГРЕССИВНО)
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

  // 🔥 СИЛЬНОЕ объединение
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
// MAIN
// =========================
document.getElementById("processBtn").onclick = async () => {
  const file = document.getElementById("fileInput").files[0];
  if (!file) return alert("Выбери файл");

  await loadFFmpeg();
  logs = [];

  setStatus("Загрузка...");
  ffmpeg.FS("writeFile", "input.mp4", await fetchFile(file));

  const duration = document.getElementById("duration").value;
  const threshold = document.getElementById("threshold").value;

  // =========================
  // DETECT
  // =========================
  setStatus("Поиск тишины...");

  await ffmpeg.run(
    "-i", "input.mp4",
    "-af", `silencedetect=noise=${threshold}dB:d=${duration}`,
    "-f", "null",
    "-"
  );

  const silences = parseSilence(logs);
  const totalDuration = getDuration(logs);

  let segments = buildSegments(silences, totalDuration);

  const PAD = 0.05;
  segments = segments.map(s => ({
    start: Math.max(0, s.start - PAD),
    end: s.end + PAD
  }));

  setStatus(`Сегментов: ${segments.length}`);

  // =========================
  // CUT (FAST + FALLBACK)
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
  // CONCAT (БЫСТРО)
  // =========================
  setStatus("Склейка...");

  let concatList = "";
  for (let i = 0; i < segments.length; i++) {
    concatList += `file part${i}.mp4\n`;
  }

  ffmpeg.FS("writeFile", "list.txt", new TextEncoder().encode(concatList));

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

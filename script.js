const { createFFmpeg, fetchFile } = FFmpeg;

const ffmpeg = createFFmpeg({ log: true });

let loaded = false;
let logs = [];

ffmpeg.setLogger(({ message }) => {
  logs.push(message);
});

ffmpeg.setProgress(({ ratio }) => {
  document.getElementById("progress").innerText =
    "Processing: " + Math.round(ratio * 100) + "%";
});

async function loadFFmpeg() {
  if (!loaded) {
    await ffmpeg.load();
    loaded = true;
  }
}

// =====================
// PREVIEW
// =====================
document.getElementById("fileInput").onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  document.getElementById("preview").src = url;
};

// =====================
// PARSE SILENCE
// =====================
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

// =====================
// GET DURATION
// =====================
function getDuration(logs) {
  for (const line of logs) {
    const m = line.match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);
    if (m) {
      return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    }
  }
  return 0;
}

// =====================
// BUILD SEGMENTS
// =====================
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

// =====================
// MAIN PROCESS
// =====================
document.getElementById("processBtn").onclick = async () => {
  const file = document.getElementById("fileInput").files[0];

  if (!file) {
    alert("Выбери файл");
    return;
  }

  if (file.size > 200 * 1024 * 1024) {
    alert("Файл слишком большой (макс ~200MB)");
    return;
  }

  const duration = document.getElementById("duration").value;
  const threshold = document.getElementById("threshold").value;

  await loadFFmpeg();

  logs = [];

  ffmpeg.FS("writeFile", "input.mp4", await fetchFile(file));

  // =====================
  // 1. DETECT SILENCE
  // =====================
  await ffmpeg.run(
    "-i", "input.mp4",
    "-af", `silencedetect=noise=${threshold}dB:d=${duration}`,
    "-f", "null",
    "-"
  );

  const silences = parseSilence(logs);

  if (!silences.length) {
    alert("Тишина не найдена");
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

  if (segments.length > 100) {
    alert("Слишком много сегментов");
    return;
  }

  // =====================
  // 2. CUT PARTS
  // =====================
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];

    await ffmpeg.run(
      "-i", "input.mp4",
      "-ss", String(s.start),
      "-to", String(s.end),
      "-c", "copy",
      `part${i}.mp4`
    );
  }

  // =====================
  // 3. CONCAT LIST
  // =====================
  let concatList = "";

  for (let i = 0; i < segments.length; i++) {
    concatList += `file part${i}.mp4\n`;
  }

  ffmpeg.FS(
    "writeFile",
    "list.txt",
    new TextEncoder().encode(concatList)
  );

  // =====================
  // 4. MERGE
  // =====================
  await ffmpeg.run(
    "-f", "concat",
    "-safe", "0",
    "-i", "list.txt",
    "-c", "copy",
    "output.mp4"
  );

  // =====================
  // 5. RESULT
  // =====================
  const data = ffmpeg.FS("readFile", "output.mp4");

  const url = URL.createObjectURL(
    new Blob([data.buffer], { type: "video/mp4" })
  );

  const video = document.getElementById("preview");
  video.src = url;

  const downloadBtn = document.getElementById("downloadBtn");
  downloadBtn.href = url;
  downloadBtn.style.display = "inline";
};

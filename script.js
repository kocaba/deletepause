const { createFFmpeg, fetchFile } = FFmpeg;

const ffmpeg = createFFmpeg({ log: true });

let loaded = false;
let logs = [];

// логирование ffmpeg
ffmpeg.setLogger(({ message }) => {
  logs.push(message);
});

// прогресс
ffmpeg.setProgress(({ ratio }) => {
  console.log("Progress:", Math.round(ratio * 100) + "%");
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

    if (start) {
      current = { start: parseFloat(start[1]) };
    }

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
// FILTER COMPLEX
// =====================
function buildFilter(segments) {
  let filter = "";
  let concat = "";

  segments.forEach((seg, i) => {
    filter += `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}];`;
    filter += `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}];`;
    concat += `[v${i}][a${i}]`;
  });

  filter += `${concat}concat=n=${segments.length}:v=1:a=1[outv][outa]`;

  return filter;
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

  // =====================
  // 2. GET DURATION
  // =====================
  const totalDuration = getDuration(logs);

  // =====================
  // 3. BUILD SEGMENTS
  // =====================
  let segments = buildSegments(silences, totalDuration);

  // небольшой padding (как в тиктоке)
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
  // 4. BUILD FILTER
  // =====================
  const filter = buildFilter(segments);

  // =====================
  // 5. RENDER
  // =====================
  await ffmpeg.run(
    "-i", "input.mp4",
    "-filter_complex", filter,
    "-map", "[outv]",
    "-map", "[outa]",
    "-preset", "veryfast",
    "output.mp4"
  );

  // =====================
  // 6. RESULT
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

const { createFFmpeg, fetchFile } = FFmpeg;

const ffmpeg = createFFmpeg({ log: true });

let loaded = false;

async function loadFFmpeg() {
  if (!loaded) {
    await ffmpeg.load();
    loaded = true;
  }
}

// превью исходного видео
document.getElementById("fileInput").onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  document.getElementById("preview").src = url;
};

document.getElementById("processBtn").onclick = async () => {
  const file = document.getElementById("fileInput").files[0];
  if (!file) {
    alert("Выбери файл");
    return;
  }

  const duration = document.getElementById("duration").value;
  const threshold = document.getElementById("threshold").value;

  await loadFFmpeg();

  ffmpeg.FS("writeFile", "input.mp4", await fetchFile(file));

  // 🔥 удаление тишины
  await ffmpeg.run(
    "-i", "input.mp4",
    "-af", `silenceremove=stop_periods=-1:stop_duration=${duration}:stop_threshold=${threshold}dB`,
    "-c:v", "copy",
    "output.mp4"
  );

  const data = ffmpeg.FS("readFile", "output.mp4");

  const url = URL.createObjectURL(
    new Blob([data.buffer], { type: "video/mp4" })
  );

  // показать результат в плеере
  const video = document.getElementById("preview");
  video.src = url;

  // показать кнопку скачать
  const downloadBtn = document.getElementById("downloadBtn");
  downloadBtn.href = url;
  downloadBtn.style.display = "inline";
};

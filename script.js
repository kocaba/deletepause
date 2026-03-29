// script.js

let ffmpeg;
let loaded = false;

async function loadFFmpeg() {
  if (loaded) return;

  console.log("Loading FFmpeg...");

  // ждём пока библиотека появится
  while (typeof FFmpeg === "undefined") {
    await new Promise(r => setTimeout(r, 100));
  }

  const { createFFmpeg, fetchFile } = FFmpeg;

  ffmpeg = createFFmpeg({
    log: true,
    corePath: "./ffmpeg/ffmpeg-core.js"
  });

  await ffmpeg.load();

  loaded = true;

  console.log("FFmpeg loaded");
}

async function processVideo() {
  const input = document.getElementById("fileInput").files[0];
  if (!input) {
    alert("Выбери файл");
    return;
  }

  await loadFFmpeg();

  const { fetchFile } = FFmpeg;

  await ffmpeg.FS("writeFile", "input.mp4", await fetchFile(input));

  await ffmpeg.run(
    "-i", "input.mp4",
    "-c", "copy",
    "output.mp4"
  );

  const data = ffmpeg.FS("readFile", "output.mp4");

  const url = URL.createObjectURL(
    new Blob([data.buffer], { type: "video/mp4" })
  );

  const a = document.createElement("a");
  a.href = url;
  a.download = "output.mp4";
  a.click();
}

document.getElementById("processBtn").onclick = processVideo;

// script.js

const { createFFmpeg, fetchFile } = FFmpeg;

const ffmpeg = createFFmpeg({
  log: true,
  corePath: "./ffmpeg/ffmpeg-core.js"
});

let loaded = false;

async function loadFFmpeg() {
  if (loaded) return;

  console.log("Loading FFmpeg...");

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

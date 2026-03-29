// script.js

const { FFmpeg } = window.FFmpegWASM || {};

const ffmpeg = new FFmpeg();

let loaded = false;

async function loadFFmpeg() {
  if (loaded) return;

  console.log("Loading FFmpeg...");

  await ffmpeg.load({
    coreURL: "./ffmpeg/ffmpeg-core.js",
    wasmURL: "./ffmpeg/ffmpeg-core.wasm",
    workerURL: "./ffmpeg/ffmpeg-core.worker.js"
  });

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

  const data = await input.arrayBuffer();

  await ffmpeg.writeFile("input.mp4", new Uint8Array(data));

  // ❗ ТУТ ТВОЯ ЛОГИКА УДАЛЕНИЯ ПАУЗ (пока просто копия)
  await ffmpeg.exec([
    "-i", "input.mp4",
    "-c", "copy",
    "output.mp4"
  ]);

  const output = await ffmpeg.readFile("output.mp4");

  const url = URL.createObjectURL(
    new Blob([output.buffer], { type: "video/mp4" })
  );

  const a = document.createElement("a");
  a.href = url;
  a.download = "output.mp4";
  a.click();
}

// кнопка
document.getElementById("processBtn").onclick = processVideo;

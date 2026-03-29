const { createFFmpeg, fetchFile } = FFmpeg;

const ffmpeg = createFFmpeg({
  log: true,
  corePath: "/ffmpeg/ffmpeg-core.js"
});

let file;

document.getElementById("uploader").addEventListener("change", (e) => {
  file = e.target.files[0];
});

async function start() {
  if (!file) return alert("Upload file");

  if (!ffmpeg.isLoaded()) {
    await ffmpeg.load();
  }

  ffmpeg.FS("writeFile", "input.mp4", await fetchFile(file));

  await ffmpeg.run(
    "-i", "input.mp4",
    "-af", "silenceremove=1:0:-50dB",
    "output.mp4"
  );

  const data = ffmpeg.FS("readFile", "output.mp4");

  const url = URL.createObjectURL(
    new Blob([data.buffer], { type: "video/mp4" })
  );

  document.getElementById("preview").src = url;
}
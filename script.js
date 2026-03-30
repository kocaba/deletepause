// глобально храним аудио данные
let audioData = null;
let audioDuration = 0;

// =========================
// ЗАГРУЗКА И ДЕКОД АУДИО
// =========================
async function loadAudioData(file) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();

  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  audioData = audioBuffer.getChannelData(0); // моно
  audioDuration = audioBuffer.duration;
}

// =========================
// ПОИСК ТИШИНЫ (БЕЗ FFMPEG)
// =========================
function detectSilencePCM(thresholdDb, minDuration) {
  const threshold = Math.pow(10, thresholdDb / 20); // dB → amplitude

  const sampleRate = 44100; // приблизительно
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
        const duration = time - silenceStart;

        if (duration >= minDuration) {
          silences.push({
            start: silenceStart,
            end: time
          });
        }

        silenceStart = null;
      }
    }
  }

  return silences;
}

// =========================
// РИСОВКА
// =========================
function drawWaveformWithSilence(threshold, minDuration) {
  const canvas = document.getElementById("waveform");
  const ctx = canvas.getContext("2d");

  // делаем canvas адаптивным
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  const width = canvas.width;
  const height = canvas.height;

  const step = Math.ceil(audioData.length / width);
  const amp = height / 2;

  ctx.clearRect(0, 0, width, height);

  // =========================
  // РИСУЕМ WAVEFORM
  // =========================
  ctx.fillStyle = "#888";

  for (let i = 0; i < width; i++) {
    let min = 1;
    let max = -1;

    for (let j = 0; j < step; j++) {
      const datum = audioData[(i * step) + j] || 0;
      if (datum < min) min = datum;
      if (datum > max) max = datum;
    }

    ctx.fillRect(
      i,
      (1 + min) * amp,
      1,
      Math.max(1, (max - min) * amp)
    );
  }

  // =========================
  // НАХОДИМ ТИШИНУ
  // =========================
  const silences = detectSilencePCM(threshold, minDuration);

  // =========================
  // РИСУЕМ КРАСНЫЕ ЗОНЫ
  // =========================
  ctx.fillStyle = "rgba(255,0,0,0.3)";

  silences.forEach(s => {
    const x1 = (s.start / audioDuration) * width;
    const x2 = (s.end / audioDuration) * width;

    ctx.fillRect(x1, 0, x2 - x1, height);
  });
}

// =========================
// ПРИ ЗАГРУЗКЕ ФАЙЛА
// =========================
document.getElementById("fileInput").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  document.getElementById("preview").src =
    URL.createObjectURL(file);

  setStatus("Анализ аудио...");

  await loadAudioData(file);

  // первый рендер
  updateWaveform();

  setStatus("Готово");
};

// =========================
// ОБНОВЛЕНИЕ ПРИ ИЗМЕНЕНИИ
// =========================
function updateWaveform() {
  const threshold = parseFloat(document.getElementById("threshold").value);
  const duration = parseFloat(document.getElementById("duration").value);

  drawWaveformWithSilence(threshold, duration);
}

// слушаем изменения
document.getElementById("threshold").oninput = updateWaveform;
document.getElementById("duration").oninput = updateWaveform;

// =========================
// РЕСАЙЗ (АДАПТИВ)
// =========================
window.addEventListener("resize", () => {
  if (audioData) updateWaveform();
});

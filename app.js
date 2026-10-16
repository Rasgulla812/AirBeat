/* AirBeat - Web Audio instrument and TensorFlow.js hand trigger. */
const video = document.querySelector("#camera");
const overlay = document.querySelector("#hand-overlay");
const ctx = overlay.getContext("2d");
const cameraButton = document.querySelector("#camera-button");
const cameraLabel = document.querySelector("#camera-button-label");
const soundButton = document.querySelector("#sound-button");
const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioContext = new AudioContext();
const master = audioContext.createGain();
const compressor = audioContext.createDynamicsCompressor();
master.gain.value = 0.72;
compressor.threshold.value = -18;
compressor.knee.value = 12;
compressor.ratio.value = 4;
compressor.attack.value = 0.003;
compressor.release.value = 0.18;
master.connect(compressor);
compressor.connect(audioContext.destination);

let stream;
let model;
let modelLoading;
let tracking = false;
const fingertipIndices = [4, 8, 12, 16, 20];
let previousFingertips = new Map();
let lastHitAt = new Map();
let lastFrame = performance.now();

async function unlockAudio() {
  if (audioContext.state !== "running") await audioContext.resume();
  document.querySelector("#sound-button").textContent = "Sound enabled";
  document.querySelector("#connection-label").textContent = "sound enabled";
}

function noiseBuffer(duration) {
  const buffer = audioContext.createBuffer(1, audioContext.sampleRate * duration, audioContext.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

async function hit(sound) {
  try {
    await unlockAudio();
  } catch (error) {
    console.error("Unable to start audio:", error);
    return;
  }
  const now = audioContext.currentTime;
  const gain = audioContext.createGain();
  const oscillator = audioContext.createOscillator();
  gain.connect(master);
  if (sound === "kick") {
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(145, now);
    oscillator.frequency.exponentialRampToValueAtTime(42, now + .22);
    gain.gain.setValueAtTime(1.15, now);
    gain.gain.exponentialRampToValueAtTime(.001, now + .42);
    oscillator.connect(gain); oscillator.start(now); oscillator.stop(now + .44);
  } else if (sound === "tom") {
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(230, now);
    oscillator.frequency.exponentialRampToValueAtTime(88, now + .28);
    gain.gain.setValueAtTime(.78, now); gain.gain.exponentialRampToValueAtTime(.001, now + .38);
    oscillator.connect(gain); oscillator.start(now); oscillator.stop(now + .39);
  } else {
    const source = audioContext.createBufferSource();
    const cymbal = sound === "crash" || sound === "ride";
    source.buffer = noiseBuffer(sound === "hat" ? .06 : cymbal ? .45 : .18);
    const filter = audioContext.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = sound === "hat" ? 5000 : cymbal ? 2500 : 900;
    filter.Q.value = sound === "hat" ? .6 : cymbal ? .35 : 1;
    gain.gain.setValueAtTime(sound === "hat" ? .28 : cymbal ? (sound === "crash" ? .42 : .3) : .62, now);
    gain.gain.exponentialRampToValueAtTime(.001, now + (sound === "hat" ? .065 : cymbal ? (sound === "crash" ? .75 : .48) : .2));
    source.connect(filter); filter.connect(gain); source.start(now);
  }
  const pad = document.querySelector(`[data-sound="${sound}"]`);
  if (pad) {
    pad.classList.add("hit");
    setTimeout(() => pad.classList.remove("hit"), 100);
  }
  document.querySelectorAll(`.instrument-zone[data-zone="${sound}"]`).forEach((zone) => {
    zone.classList.add("active");
    setTimeout(() => zone.classList.remove("active"), 130);
  });
}

function resizeOverlay() {
  if (!video.videoWidth) return;
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
}

function drawHands(predictions) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  predictions.forEach((hand) => {
    const points = hand.landmarks;
    ctx.strokeStyle = "#d8f64b"; ctx.lineWidth = 3;
    [[0, 5], [5, 9], [9, 13], [13, 17], [17, 0], [5, 13], [9, 17]].forEach(([a, b]) => {
      ctx.beginPath(); ctx.moveTo(points[a][0], points[a][1]); ctx.lineTo(points[b][0], points[b][1]); ctx.stroke();
    });
    points.forEach(([x, y], index) => {
      ctx.fillStyle = index === 8 ? "#fff" : "#d8f64b";
      ctx.beginPath(); ctx.arc(x, y, index === 8 ? 8 : 3, 0, Math.PI * 2); ctx.fill();
    });
  });
}

const instrumentZones = [
  { sound: "kick", left: .34, right: .68, top: .74, bottom: 1 },
  { sound: "snare", left: .08, right: .45, top: .52, bottom: 1 },
  { sound: "hat", left: .68, right: .95, top: .52, bottom: 1 },
  { sound: "crash", left: 0, right: .3, top: 0, bottom: .48 },
  { sound: "ride", left: .7, right: 1, top: 0, bottom: .48 },
  { sound: "tom", left: .35, right: .65, top: .08, bottom: .5 },
];

function soundAtPosition(x, y) {
  const zone = instrumentZones.find((candidate) => (
    x >= candidate.left && x <= candidate.right &&
    y >= candidate.top && y <= candidate.bottom
  ));
  return zone?.sound || null;
}

async function track() {
  if (!tracking || !model) return;
  let predictions;
  try {
    predictions = await model.estimateHands(video, false);
  } catch (error) {
    tracking = false;
    document.querySelector("#tracking-status").classList.remove("active");
    document.querySelector("#tracking-status span:last-child").textContent = "tracking paused";
    document.querySelector("#fps-label").textContent = "hand tracking error";
    console.error("Hand tracking failed:", error);
    return;
  }
  drawHands(predictions);
  if (!predictions.length) {
    previousFingertips.clear();
    lastHitAt.clear();
    document.querySelector("#hand-label").textContent = "SEARCH";
  }
  const activeFingers = new Set();
  predictions.forEach((hand, index) => {
    fingertipIndices.forEach((tipIndex) => {
      const point = hand.landmarks[tipIndex];
      const fingerKey = `${index}-${tipIndex}`;
      activeFingers.add(fingerKey);
      const old = previousFingertips.get(fingerKey);
      const now = performance.now();
      // The video and skeleton are mirrored for the player, so map the fingertip
      // using its on-screen (rather than camera-sensor) horizontal position.
      const x = Math.max(0, Math.min(1, 1 - point[0] / video.videoWidth));
      const y = Math.max(0, Math.min(1, point[1] / video.videoHeight));
      if (old) {
        const downwardDistance = point[1] - old.y;
        const sound = soundAtPosition(x, y);
        const lastHit = lastHitAt.get(fingerKey) || 0;
        if (sound && downwardDistance > 3 && now - lastHit > 220) {
          hit(sound);
          lastHitAt.set(fingerKey, now);
        }
      }
      previousFingertips.set(fingerKey, { x: point[0], y: point[1], time: now });
    });
    const indexTip = hand.landmarks[8];
    const indexX = Math.max(0, Math.min(1, 1 - indexTip[0] / video.videoWidth));
    const indexY = Math.max(0, Math.min(1, indexTip[1] / video.videoHeight));
    document.querySelector("#coord-x").textContent = Math.round(indexTip[0]);
    document.querySelector("#coord-y").textContent = Math.round(indexTip[1]);
    const sound = soundAtPosition(indexX, indexY);
    document.querySelector("#hand-label").textContent = `${sound ? sound.toUpperCase() : "MOVE TO A ZONE"} / ${predictions.length * fingertipIndices.length} FINGERS`;
  });
  previousFingertips.forEach((_, key) => {
    if (!activeFingers.has(key)) {
      previousFingertips.delete(key);
      lastHitAt.delete(key);
    }
  });
  document.querySelector("#fps-label").textContent = `${Math.round(1000 / (performance.now() - lastFrame))} FPS / TFJS`;
  lastFrame = performance.now();
  requestAnimationFrame(track);
}

async function startCamera() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera access is not supported in this browser.");
    }
    await unlockAudio();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 960 }, audio: false });
    video.srcObject = stream; await video.play(); resizeOverlay();
    tracking = true; cameraLabel.textContent = "Camera on";
    document.querySelector("#camera-empty").style.display = "none";
    video.style.display = "block";
    document.querySelector("#connection-label").textContent = "camera connected";
    document.querySelector("#model-loading").style.display = "flex";
    document.querySelector("#tracking-status span:last-child").textContent = "loading hand model";
    document.querySelector("#fps-label").textContent = "loading hand model...";
    modelLoading ??= handpose.load();
    model = await modelLoading;
    document.querySelector("#model-loading").style.display = "none";
    document.querySelector("#tracking-status").classList.add("active");
    document.querySelector("#tracking-status span:last-child").textContent = "hands ready";
    document.querySelector("#fps-label").textContent = "model ready / looking for hands";
    track();
  } catch (error) {
    tracking = false;
    stream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    document.querySelector("#model-loading").style.display = "none";
    video.style.display = "none";
    document.querySelector("#camera-empty").style.display = "flex";
    cameraLabel.textContent = "Start camera";
    document.querySelector("#tracking-status").classList.remove("active");
    document.querySelector("#connection-label").textContent = "camera unavailable";
    document.querySelector("#tracking-status span:last-child").textContent = "use the pads below";
    document.querySelector("#fps-label").textContent = "model offline";
    console.error("Unable to start camera or hand model:", error);
  }
}

cameraButton.addEventListener("click", async () => {
  if (tracking) {
    tracking = false; stream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    video.style.display = "none"; document.querySelector("#camera-empty").style.display = "flex";
    document.querySelector("#model-loading").style.display = "none";
    cameraLabel.textContent = "Start camera"; document.querySelector("#connection-label").textContent = "ready to play";
    document.querySelector("#tracking-status").classList.remove("active");
    document.querySelector("#tracking-status span:last-child").textContent = "waiting for camera";
    document.querySelector("#fps-label").textContent = "model offline";
  } else await startCamera();
});
soundButton.addEventListener("click", async () => {
  try {
    await unlockAudio();
    hit("hat");
  } catch (error) {
    document.querySelector("#connection-label").textContent = "sound unavailable";
    console.error("Unable to enable sound:", error);
  }
});
document.querySelector("#volume").addEventListener("input", (event) => {
  master.gain.value = event.target.value / 100;
  document.querySelector("#volume-value").textContent = `${event.target.value}%`;
});
document.querySelectorAll(".pad").forEach((pad) => pad.addEventListener("pointerdown", () => hit(pad.dataset.sound)));
document.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  const map = { " ": "kick", j: "snare", k: "hat", l: "tom" };
  if (map[event.key.toLowerCase()]) { event.preventDefault(); hit(map[event.key.toLowerCase()]); }
});
window.addEventListener("resize", resizeOverlay);

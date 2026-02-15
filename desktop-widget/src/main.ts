import "./style.css";
import { loadWidgetConfig } from "./widget-config";
import type { AvatarRenderer, Phase } from "./renderers/types";
import { OrbRenderer } from "./renderers/orb-renderer";
import { Live2DRenderer } from "./renderers/live2d-renderer";
import { MoziClient } from "./services/mozi-client";
import { AudioPlaybackService } from "./services/audio-playback";
import { AudioCaptureService } from "./services/audio-capture";

// ── DOM setup ──

const appEl = document.querySelector<HTMLDivElement>("#app");
if (!appEl) throw new Error("Widget root not found");

const root = document.createElement("div");
root.className = "widget-root";

const avatarContainer = document.createElement("div");
avatarContainer.className = "avatar-container";

const hud = document.createElement("div");
hud.className = "hud";
const phaseLabel = document.createElement("span");
phaseLabel.textContent = "phase: idle";
const statusLabel = document.createElement("span");
statusLabel.textContent = "channel: connecting";
hud.append(phaseLabel, statusLabel);

const composer = document.createElement("div");
composer.className = "composer";
const micBtn = document.createElement("button");
micBtn.className = "mic-btn";
micBtn.textContent = "Mic";
const input = document.createElement("input");
input.placeholder = "Type a message…";
const sendBtn = document.createElement("button");
sendBtn.textContent = "Send";
composer.append(micBtn, input, sendBtn);

root.append(avatarContainer, hud, composer);
appEl.appendChild(root);

// ── Bootstrap ──

void bootstrap();

async function bootstrap(): Promise<void> {
  const config = await loadWidgetConfig();

  if (!config.enabled) {
    statusLabel.textContent = "channel: disabled by config";
    sendBtn.disabled = true;
    input.disabled = true;
    micBtn.disabled = true;
    return;
  }

  // ── Avatar renderer ──

  let renderer: AvatarRenderer;
  let live2d: Live2DRenderer | null = null;

  if (config.avatar.mode === "live2d" && config.avatar.modelPath) {
    try {
      const l2d = new Live2DRenderer(config.avatar.modelPath, config.avatar.scale);
      await l2d.init(avatarContainer);
      renderer = l2d;
      live2d = l2d;
    } catch (err) {
      console.warn("Live2D failed to load, falling back to orb:", err);
      while (avatarContainer.firstChild) {
        avatarContainer.removeChild(avatarContainer.firstChild);
      }
      renderer = new OrbRenderer();
      await renderer.init(avatarContainer);
    }
  } else {
    renderer = new OrbRenderer();
    await renderer.init(avatarContainer);
  }

  window.addEventListener("resize", () => renderer.resize());

  // ── Services ──

  const baseUrl = `http://${config.host}:${config.port}`;
  const client = new MoziClient({
    baseUrl,
    peerId: config.peerId,
    authToken: config.authToken,
  });

  const playback = new AudioPlaybackService();
  const capture = new AudioCaptureService();

  // ── SSE events → renderer ──

  client.on("phase", (phase: Phase) => {
    phaseLabel.textContent = `phase: ${phase}`;
    renderer.setPhase(phase);
  });

  client.on("sseConnected", () => {
    statusLabel.textContent = `channel: connected ${config.host}:${config.port}`;
  });

  client.on("sseDisconnected", () => {
    statusLabel.textContent = "channel: disconnected";
  });

  client.on("assistantMessage", () => {
    statusLabel.textContent = "channel: reply received";
  });

  // ── WS audio → playback → renderer ──

  client.on("audioMeta", (streamId, mimeType, durationMs, text) => {
    playback.handleAudioMeta(streamId, mimeType, durationMs, text);
  });

  client.on("audioChunk", (streamId, chunkBase64, isLast) => {
    playback.handleAudioChunk(streamId, chunkBase64, isLast);
  });

  playback.onAudioReady = (_streamId, blobUrl, _mimeType) => {
    if (live2d) {
      // Live2D built-in lip sync
      live2d.speakAudio(blobUrl);
    } else {
      // Orb fallback: just play audio
      playback.playBlobUrl(blobUrl);
    }
  };

  // ── Mic capture → WS ──

  capture.onChunk = (streamId, seq, sampleRate, chunkBase64) => {
    client.sendAudioChunk(streamId, seq, sampleRate, chunkBase64);
  };

  capture.onCommit = (streamId, totalChunks, reason) => {
    client.sendAudioCommit(streamId, totalChunks, reason);
  };

  // ── UI interactions ──

  sendBtn.addEventListener("click", () => {
    const text = input.value.trim();
    if (!text) return;
    client.sendText(text);
    input.value = "";
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const text = input.value.trim();
      if (!text) return;
      client.sendText(text);
      input.value = "";
    }
  });

  micBtn.addEventListener("click", () => {
    if (capture.isCapturing) {
      capture.stop("manual_stop");
      micBtn.classList.remove("active");
      micBtn.textContent = "Mic";
    } else {
      void capture.start().then(() => {
        micBtn.classList.add("active");
        micBtn.textContent = "Stop";
      });
    }
  });

  // ── Connect ──

  client.connectSse();
  client.connectWs();
}

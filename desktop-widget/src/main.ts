import "./style.css";
import { Live2DRenderer } from "./renderers/live2d-renderer";
import { OrbRenderer } from "./renderers/orb-renderer";
import type { AvatarRenderer, Phase } from "./renderers/types";
import { AudioCaptureService } from "./services/audio-capture";
import { AudioPlaybackService } from "./services/audio-playback";
import { MoziClient } from "./services/mozi-client";
import { loadWidgetConfig, type VoiceInputMode, type WidgetMode } from "./widget-config";

type UiPhase = "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "error";

const PHASE_LABELS: Record<UiPhase, string> = {
  idle: "空闲",
  listening: "聆听中",
  transcribing: "转写中",
  thinking: "思考中",
  speaking: "正在说话",
  error: "出错",
};

const CONNECTION_LABELS: Record<"connecting" | "connected" | "disconnected" | "disabled", string> =
  {
    connecting: "连接中",
    connected: "已连接",
    disconnected: "未连接",
    disabled: "已停用",
  };

// ── DOM setup ──

const appEl = document.querySelector<HTMLDivElement>("#app");
if (!appEl) throw new Error("Widget root not found");

const root = document.createElement("div");
root.className = "widget-root";

const avatarContainer = document.createElement("div");
avatarContainer.className = "avatar-container";

const statusBar = document.createElement("div");
statusBar.className = "status-bar";
const statusLeft = document.createElement("div");
statusLeft.className = "status-left";
const connectionLabel = document.createElement("span");
connectionLabel.className = "status-pill connection";
connectionLabel.textContent = "连接中";
const phaseLabel = document.createElement("span");
phaseLabel.className = "status-pill phase";
phaseLabel.textContent = "空闲";
statusLeft.append(connectionLabel, phaseLabel);
const statusRight = document.createElement("div");
statusRight.className = "status-right";
const modeToggle = document.createElement("div");
modeToggle.className = "mode-toggle";
const voiceModeBtn = document.createElement("button");
voiceModeBtn.type = "button";
voiceModeBtn.textContent = "语音";
const textModeBtn = document.createElement("button");
textModeBtn.type = "button";
textModeBtn.textContent = "文本";
modeToggle.append(voiceModeBtn, textModeBtn);
statusRight.append(modeToggle);
statusBar.append(statusLeft, statusRight);

const subtitle = document.createElement("div");
subtitle.className = "subtitle";
const subtitleLabel = document.createElement("div");
subtitleLabel.className = "subtitle-text";
subtitle.append(subtitleLabel);

const controlDock = document.createElement("div");
controlDock.className = "control-dock";
const voiceControls = document.createElement("div");
voiceControls.className = "voice-controls";
const pttButton = document.createElement("button");
pttButton.className = "ptt-button";
pttButton.type = "button";
pttButton.textContent = "按住说话";
const voiceHint = document.createElement("div");
voiceHint.className = "voice-hint";
voiceHint.textContent = "按住说话";
voiceControls.append(pttButton, voiceHint);

const textControls = document.createElement("div");
textControls.className = "text-controls";
const input = document.createElement("input");
input.placeholder = "输入消息...";
const sendBtn = document.createElement("button");
sendBtn.type = "button";
sendBtn.textContent = "发送";
const playBtn = document.createElement("button");
playBtn.type = "button";
playBtn.className = "play-btn";
playBtn.textContent = "播放语音";
playBtn.disabled = true;
textControls.append(input, sendBtn, playBtn);

controlDock.append(voiceControls, textControls);

root.append(avatarContainer, statusBar, subtitle, controlDock);
appEl.appendChild(root);

// ── Bootstrap ──

void bootstrap();

async function bootstrap(): Promise<void> {
  const config = await loadWidgetConfig();
  const disabled = !config.enabled;
  let mode: WidgetMode = config.mode;
  let voiceInputMode: VoiceInputMode = config.voiceInputMode;
  const voiceOutputEnabled = config.voiceOutputEnabled;
  const textOutputEnabled = config.textOutputEnabled;
  let currentPhase: Phase = "idle";
  let uiPhase: UiPhase = "idle";
  let connectionState: "connecting" | "connected" | "disconnected" = "connecting";
  let pttActive = false;
  let pttHeld = false;
  let capturePending = false;
  let transcribing = false;
  let liveTranscript = "";
  let lastTranscript = "";
  let lastAssistant = "";
  let awaitingReply = false;
  let lastError: string | null = null;
  let lastAudio: { blobUrl: string; mimeType: string } | null = null;
  let transcribeTimer: ReturnType<typeof setTimeout> | null = null;
  const TRANSCRIBE_TIMEOUT_MS = 6000;

  root.dataset.mode = mode;
  root.dataset.voiceInput = voiceInputMode;

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

  const onResize = () => renderer.resize();
  window.addEventListener("resize", onResize);

  // ── Services ──

  const baseUrl = `http://${config.host}:${config.port}`;
  const client = disabled
    ? null
    : new MoziClient({
        baseUrl,
        peerId: config.peerId,
        authToken: config.authToken,
      });

  const playback = disabled ? null : new AudioPlaybackService();
  const capture = disabled ? null : new AudioCaptureService();

  // ── SSE events → renderer ──

  const updateConnectionLabel = () => {
    if (disabled) {
      connectionLabel.dataset.state = "disabled";
      connectionLabel.textContent = CONNECTION_LABELS.disabled;
      return;
    }
    if (connectionState === "connected") {
      connectionLabel.dataset.state = "connected";
      connectionLabel.textContent = `${CONNECTION_LABELS.connected} ${config.host}:${config.port}`;
      return;
    }
    connectionLabel.dataset.state = connectionState;
    connectionLabel.textContent = CONNECTION_LABELS[connectionState];
  };

  const updatePhaseLabel = () => {
    const listeningActive =
      pttActive || (voiceInputMode === "vad" && (capture?.isCapturing ?? false));
    if (disabled) {
      uiPhase = "idle";
    } else if (lastError || currentPhase === "error") {
      uiPhase = "error";
    } else if (listeningActive) {
      uiPhase = "listening";
    } else if (transcribing) {
      uiPhase = "transcribing";
    } else if (currentPhase === "speaking") {
      uiPhase = "speaking";
    } else if (currentPhase === "thinking" || currentPhase === "executing") {
      uiPhase = "thinking";
    } else {
      uiPhase = "idle";
    }

    phaseLabel.dataset.phase = uiPhase;
    phaseLabel.textContent = PHASE_LABELS[uiPhase];

    const avatarPhase: Phase = uiPhase === "transcribing" ? "thinking" : uiPhase;
    renderer.setPhase(avatarPhase);
    root.dataset.phase = uiPhase;
  };

  const setTranscribing = (active: boolean) => {
    transcribing = active;
    if (transcribeTimer) {
      clearTimeout(transcribeTimer);
      transcribeTimer = null;
    }
    if (active) {
      transcribeTimer = setTimeout(() => {
        transcribing = false;
        updatePhaseLabel();
        updateVoiceHint();
      }, TRANSCRIBE_TIMEOUT_MS);
    }
    updatePhaseLabel();
    updateVoiceHint();
  };

  const updateSubtitle = () => {
    if (!textOutputEnabled) {
      subtitle.classList.add("is-hidden");
      subtitleLabel.textContent = "";
      return;
    }
    let role = "";
    let text = "";
    if (uiPhase === "error" && lastError) {
      role = "系统";
      text = lastError;
    } else if (mode === "voice") {
      if (liveTranscript) {
        role = "你";
        text = liveTranscript;
      } else if (awaitingReply && lastTranscript) {
        role = "你";
        text = lastTranscript;
      } else if (lastAssistant) {
        role = "Mozi";
        text = lastAssistant;
      }
    } else if (lastAssistant) {
      role = "Mozi";
      text = lastAssistant;
    }

    if (!text) {
      subtitle.classList.add("is-hidden");
      subtitleLabel.textContent = "";
      return;
    }
    subtitle.classList.remove("is-hidden");
    subtitle.dataset.role = role === "你" ? "user" : role === "Mozi" ? "assistant" : "system";
    subtitleLabel.textContent = `${role}：${text}`;
  };

  const updatePttButton = () => {
    if (voiceInputMode === "ptt") {
      pttButton.textContent = pttActive ? "松开发送" : "按住说话";
    } else {
      const listening = capture?.isCapturing ?? false;
      pttButton.textContent = listening ? "停止倾听" : "开始倾听";
    }
    pttButton.classList.toggle(
      "active",
      pttActive || (voiceInputMode === "vad" && (capture?.isCapturing ?? false)),
    );
  };

  const updateVoiceHint = () => {
    if (disabled) {
      voiceHint.textContent = "语音输入已停用";
      return;
    }
    if (lastError) {
      voiceHint.textContent = "出现错误，请重试";
      return;
    }
    if (capturePending) {
      voiceHint.textContent = "正在打开麦克风...";
      return;
    }
    const listeningActive =
      pttActive || (voiceInputMode === "vad" && (capture?.isCapturing ?? false));
    if (listeningActive) {
      voiceHint.textContent = "正在聆听...";
      return;
    }
    if (transcribing) {
      voiceHint.textContent = "正在转写...";
      return;
    }
    if (currentPhase === "speaking") {
      voiceHint.textContent = "正在说话...";
      return;
    }
    if (currentPhase === "thinking" || currentPhase === "executing") {
      voiceHint.textContent = "正在思考...";
      return;
    }
    if (voiceInputMode === "vad") {
      voiceHint.textContent = capture?.isCapturing ? "静音后自动发送" : "点击开始倾听";
      return;
    }
    voiceHint.textContent = "按住说话";
  };

  const updateModeUi = () => {
    root.dataset.mode = mode;
    root.dataset.voiceInput = voiceInputMode;
    root.dataset.voiceOutput = voiceOutputEnabled ? "on" : "off";
    root.dataset.textOutput = textOutputEnabled ? "on" : "off";
    voiceModeBtn.classList.toggle("active", mode === "voice");
    textModeBtn.classList.toggle("active", mode === "text");
    voiceModeBtn.disabled = disabled;
    textModeBtn.disabled = disabled;
    pttButton.disabled = disabled || mode !== "voice";
    input.disabled = disabled || mode !== "text";
    sendBtn.disabled = input.disabled;
    playBtn.disabled = mode !== "text" || !voiceOutputEnabled || !lastAudio;
    updateSubtitle();
    updateVoiceHint();
    updatePttButton();
  };

  const setMode = (next: WidgetMode) => {
    if (mode === next) return;
    mode = next;
    if (mode === "text" && capture?.isCapturing) {
      stopCapture("manual_stop");
      pttHeld = false;
    }
    updateModeUi();
    updatePhaseLabel();
  };

  const playAudio = (blobUrl: string) => {
    if (live2d) {
      live2d.speakAudio(blobUrl);
    } else {
      playback?.playBlobUrl(blobUrl);
    }
  };

  updateConnectionLabel();
  updatePhaseLabel();
  updateModeUi();

  if (client) {
    client.on("phase", (phase: Phase) => {
      currentPhase = phase;
      if (phase === "error" && !lastError) {
        lastError = "处理失败，请重试";
      }
      updatePhaseLabel();
      updateVoiceHint();
      updateSubtitle();
    });

    client.on("sseConnected", () => {
      connectionState = "connected";
      updateConnectionLabel();
    });

    client.on("sseDisconnected", () => {
      connectionState = "disconnected";
      updateConnectionLabel();
    });

    client.on("assistantMessage", (text) => {
      lastAssistant = text.trim();
      awaitingReply = false;
      lastError = null;
      setTranscribing(false);
      updateSubtitle();
      updatePhaseLabel();
      updateVoiceHint();
    });

    client.on("transcript", (text, isUser, isFinal) => {
      if (!isUser) return;
      liveTranscript = String(text ?? "");
      if (isFinal) {
        lastTranscript = liveTranscript;
        liveTranscript = "";
        awaitingReply = true;
        lastError = null;
        setTranscribing(false);
      }
      updateSubtitle();
      updatePhaseLabel();
    });

    // ── WS audio → playback → renderer ──

    client.on("audioMeta", (streamId, mimeType, durationMs, text) => {
      playback?.handleAudioMeta(streamId, mimeType, durationMs, text);
    });

    client.on("audioChunk", (streamId, chunkBase64, isLast) => {
      playback?.handleAudioChunk(streamId, chunkBase64, isLast);
    });
  }

  if (playback) {
    playback.onAudioReady = (_streamId, blobUrl, mimeType) => {
      if (!voiceOutputEnabled) {
        URL.revokeObjectURL(blobUrl);
        return;
      }
      if (lastAudio) {
        URL.revokeObjectURL(lastAudio.blobUrl);
      }
      lastAudio = { blobUrl, mimeType };
      playBtn.disabled = mode !== "text" || !lastAudio || !voiceOutputEnabled;
      if (mode === "voice") {
        playAudio(blobUrl);
      }
    };
  }

  // ── Mic capture → WS ──

  if (capture && client) {
    capture.configureVad({
      enabled: voiceInputMode === "vad",
    });

    capture.onChunk = (streamId, seq, sampleRate, chunkBase64) => {
      client.sendAudioChunk(streamId, seq, sampleRate, chunkBase64);
    };

    capture.onCommit = (streamId, totalChunks, reason) => {
      client.sendAudioCommit(streamId, totalChunks, reason);
      awaitingReply = false;
      setTranscribing(true);
    };

    capture.onLevel = (level) => {
      renderer.setMouthOpen(level);
    };

    capture.onVadStop = (reason) => {
      stopCapture(reason);
    };
  }

  // ── UI interactions ──

  voiceModeBtn.addEventListener("click", () => setMode("voice"));
  textModeBtn.addEventListener("click", () => setMode("text"));

  sendBtn.addEventListener("click", () => {
    if (disabled || !client) return;
    const text = input.value.trim();
    if (!text) return;
    client.sendText(text);
    awaitingReply = true;
    lastAssistant = "";
    lastError = null;
    if (lastAudio) {
      URL.revokeObjectURL(lastAudio.blobUrl);
      lastAudio = null;
    }
    input.value = "";
    updateSubtitle();
    updatePhaseLabel();
    updateVoiceHint();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (disabled || !client) return;
      const text = input.value.trim();
      if (!text) return;
      client.sendText(text);
      awaitingReply = true;
      lastAssistant = "";
      lastError = null;
      if (lastAudio) {
        URL.revokeObjectURL(lastAudio.blobUrl);
        lastAudio = null;
      }
      input.value = "";
      updateSubtitle();
      updatePhaseLabel();
      updateVoiceHint();
    }
  });

  playBtn.addEventListener("click", () => {
    if (!lastAudio || !voiceOutputEnabled) return;
    playAudio(lastAudio.blobUrl);
  });

  const startCapture = async () => {
    if (!capture || capturePending || capture.isCapturing) return;
    capturePending = true;
    liveTranscript = "";
    lastTranscript = "";
    awaitingReply = false;
    lastAssistant = "";
    lastError = null;
    if (lastAudio) {
      URL.revokeObjectURL(lastAudio.blobUrl);
      lastAudio = null;
    }
    setTranscribing(false);
    updateSubtitle();
    updateVoiceHint();
    try {
      await capture.start();
      pttActive = voiceInputMode === "ptt";
      updatePhaseLabel();
      if (voiceInputMode === "ptt" && !pttHeld) {
        stopCapture("manual_stop");
      }
    } catch (err) {
      console.warn("Microphone capture failed:", err);
      lastError = "无法访问麦克风";
      updatePhaseLabel();
      updateSubtitle();
      updateVoiceHint();
    } finally {
      capturePending = false;
      updatePttButton();
      updateVoiceHint();
    }
  };

  const stopCapture = (reason: "manual_stop" | "vad_silence" | "max_duration") => {
    if (!capture || !capture.isCapturing) return;
    capture.stop(reason);
    pttActive = false;
    renderer.setMouthOpen(0);
    updatePhaseLabel();
    updatePttButton();
    updateVoiceHint();
  };

  pttButton.addEventListener("pointerdown", (event) => {
    if (disabled || voiceInputMode !== "ptt") return;
    pttHeld = true;
    if (event.pointerId !== undefined) {
      pttButton.setPointerCapture(event.pointerId);
    }
    void startCapture();
  });

  pttButton.addEventListener("pointerup", () => {
    if (disabled || voiceInputMode !== "ptt") return;
    pttHeld = false;
    stopCapture("manual_stop");
  });

  pttButton.addEventListener("pointercancel", () => {
    if (disabled || voiceInputMode !== "ptt") return;
    pttHeld = false;
    stopCapture("manual_stop");
  });

  pttButton.addEventListener("click", () => {
    if (disabled || voiceInputMode !== "vad") return;
    if (capture?.isCapturing) {
      stopCapture("manual_stop");
    } else {
      void startCapture();
    }
  });

  // ── Connect ──

  if (client) {
    client.connectSse();
    client.connectWs();
  }

  // ── Cleanup on unload ──

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    window.removeEventListener("resize", onResize);
    window.removeEventListener("beforeunload", cleanup);
    capture?.destroy();
    playback?.destroy();
    client?.destroy();
    renderer.destroy();
  };
  window.addEventListener("beforeunload", cleanup, { once: true });
}

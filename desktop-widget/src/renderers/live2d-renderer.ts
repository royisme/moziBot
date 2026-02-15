import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import type { AvatarRenderer, Phase } from "./types";

Live2DModel.registerTicker(PIXI.Ticker);

export class Live2DRenderer implements AvatarRenderer {
  private app: PIXI.Application | null = null;
  private model: InstanceType<typeof Live2DModel> | null = null;
  private container: HTMLElement | null = null;
  private currentPhase: Phase = "idle";
  private manualMouthValue = 0;
  private manualMouthTarget = 0;
  private isSpeaking = false;

  constructor(
    private modelPath: string,
    private modelScale?: number,
  ) {}

  async init(container: HTMLElement): Promise<void> {
    this.container = container;

    const canvas = document.createElement("canvas");
    canvas.className = "live2d-canvas";
    container.appendChild(canvas);

    this.app = new PIXI.Application({
      view: canvas,
      backgroundAlpha: 0,
      width: container.clientWidth,
      height: container.clientHeight,
      antialias: true,
    });

    this.model = await Live2DModel.from(this.modelPath, {
      autoInteract: false,
    });

    const scale = this.modelScale ?? this.computeDefaultScale();
    this.model.scale.set(scale);
    this.model.anchor.set(0.5, 0.5);
    this.model.x = this.app.screen.width / 2;
    this.model.y = this.app.screen.height / 2;

    this.app.stage.addChild(this.model);
    this.startManualMouthLoop();
  }

  setPhase(phase: Phase): void {
    if (phase === this.currentPhase) return;
    const prev = this.currentPhase;
    this.currentPhase = phase;
    if (!this.model) return;

    switch (phase) {
      case "idle":
        if (prev === "speaking") {
          this.model.stopSpeaking();
          this.isSpeaking = false;
        }
        this.playMotionSafe("Idle", 0, 1);
        break;
      case "listening":
        this.playMotionSafe("Listening", 0, 2);
        break;
      case "thinking":
        this.playMotionSafe("Thinking", 0, 2);
        break;
      case "speaking":
        // Lip sync is driven externally via speak() or setMouthOpen()
        break;
      case "executing":
        this.playMotionSafe("Executing", 0, 2);
        break;
      case "error":
        this.setExpressionSafe("error");
        break;
    }
  }

  setMouthOpen(value: number): void {
    this.manualMouthTarget = Math.max(0, Math.min(1, value));
  }

  /**
   * Play TTS audio with built-in lip sync.
   * @param audioUrl - Blob URL or data URL pointing to the audio.
   */
  speakAudio(audioUrl: string): void {
    if (!this.model) return;
    this.isSpeaking = true;
    void this.model.speak(audioUrl, {
      volume: 1,
      onFinish: () => {
        this.isSpeaking = false;
      },
      onError: () => {
        this.isSpeaking = false;
      },
    });
  }

  stopSpeaking(): void {
    this.model?.stopSpeaking();
    this.isSpeaking = false;
  }

  resize(): void {
    if (!this.app || !this.container || !this.model) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.app.renderer.resize(width, height);
    this.model.x = width / 2;
    this.model.y = height / 2;
  }

  destroy(): void {
    this.model?.destroy();
    this.model = null;
    this.app?.destroy(true);
    this.app = null;
  }

  private computeDefaultScale(): number {
    if (!this.app || !this.model) return 0.2;
    const modelWidth = this.model.width;
    const modelHeight = this.model.height;
    if (!modelWidth || !modelHeight) return 0.2;
    const scaleX = this.app.screen.width / modelWidth;
    const scaleY = this.app.screen.height / modelHeight;
    return Math.min(scaleX, scaleY) * 0.85;
  }

  private playMotionSafe(group: string, index: number, priority: number): void {
    try {
      void this.model?.motion(group, index, priority as 0 | 1 | 2 | 3);
    } catch {
      // Motion group may not exist in this model; silently ignore.
    }
  }

  private setExpressionSafe(id: string): void {
    try {
      void this.model?.expression(id);
    } catch {
      // Expression may not exist; silently ignore.
    }
  }

  private startManualMouthLoop(): void {
    if (!this.app) return;
    this.app.ticker.add(() => {
      if (this.isSpeaking || !this.model) return;
      // Smoothly interpolate manual mouth value
      this.manualMouthValue +=
        (this.manualMouthTarget - this.manualMouthValue) * 0.3;
      if (Math.abs(this.manualMouthValue) < 0.001) {
        this.manualMouthValue = 0;
      }
      const core = (this.model.internalModel as any)?.coreModel;
      if (core && typeof core.setParameterValueById === "function") {
        core.setParameterValueById("ParamMouthOpenY", this.manualMouthValue);
      }
    });
  }
}

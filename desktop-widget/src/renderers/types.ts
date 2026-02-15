export type Phase = "idle" | "listening" | "thinking" | "speaking" | "executing" | "error";

export interface AvatarRenderer {
  init(container: HTMLElement): Promise<void>;
  setPhase(phase: Phase): void;
  setMouthOpen(value: number): void;
  resize(): void;
  destroy(): void;
}

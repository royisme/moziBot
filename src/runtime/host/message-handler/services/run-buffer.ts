const DEFAULT_MAX_CHARS = 16_000;

export class RunBuffer {
  private chunks: string[] = [];
  private totalChars = 0;

  constructor(private readonly maxChars = DEFAULT_MAX_CHARS) {}

  append(delta: string): void {
    if (!delta) {
      return;
    }
    this.chunks.push(delta);
    this.totalChars += delta.length;
    this.trim();
  }

  replaceWith(text: string): void {
    this.chunks = text ? [text] : [];
    this.totalChars = text.length;
    this.trim();
  }

  snapshot(): string {
    if (this.chunks.length === 0) {
      return "";
    }
    return this.chunks.join("");
  }

  private trim(): void {
    if (this.totalChars <= this.maxChars) {
      return;
    }

    while (this.totalChars > this.maxChars && this.chunks.length > 0) {
      const head = this.chunks[0] ?? "";
      const overflow = this.totalChars - this.maxChars;
      if (head.length <= overflow) {
        this.chunks.shift();
        this.totalChars -= head.length;
        continue;
      }
      this.chunks[0] = head.slice(overflow);
      this.totalChars -= overflow;
      break;
    }
  }
}

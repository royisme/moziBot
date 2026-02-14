import type { MoziConfig } from "../../config";
import type { InboundMessage } from "../adapters/channels/types";
import { SttService } from "./stt-service";

export type InboundMediaPreprocessResult = {
  transcript: string | null;
  hasAudioTranscript: boolean;
};

export class InboundMediaPreprocessor {
  private sttService: SttService;

  constructor(config: MoziConfig) {
    this.sttService = new SttService(config);
  }

  updateConfig(config: MoziConfig): void {
    this.sttService.updateConfig(config);
  }

  async preprocessInboundMessage(message: InboundMessage): Promise<InboundMediaPreprocessResult> {
    const transcript = await this.sttService.transcribeInboundMessage(message);
    return {
      transcript,
      hasAudioTranscript: typeof transcript === "string" && transcript.trim().length > 0,
    };
  }
}

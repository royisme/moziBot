import type { ContentPart } from "./content-part.ts";
import type { CanonicalProtocolVersion } from "./versioning.ts";

export interface CanonicalEnvelope {
  id: string;
  protocolVersion: CanonicalProtocolVersion;
  tenantId: string;
  conversationId: string;
  messageId: string;
  direction: "inbound" | "outbound";
  source: {
    channel: "telegram" | "discord" | "api";
    channelMessageId: string;
    userId: string;
  };
  parts: ContentPart[];
  createdAt: string;
  correlationId: string;
  traceId: string;
}

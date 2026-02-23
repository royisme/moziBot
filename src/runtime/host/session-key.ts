import type { InboundMessage } from "../adapters/channels/types";

export type DmScope = "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
export type SessionIdentityLinks = Record<string, string[]>;

const DEFAULT_MAIN_KEY = "main";
const DEFAULT_AGENT_ID = "mozi";
const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_CHANNEL = "unknown";
const DEFAULT_PEER = "unknown";

const VALID_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

function normalizeSegment(value: string | number | undefined | null, fallback: string): string {
  const trimmed = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!trimmed) {
    return fallback;
  }
  if (VALID_SEGMENT_RE.test(trimmed)) {
    return trimmed;
  }
  const normalized = trimmed
    .replace(INVALID_CHARS_RE, "-")
    .replace(LEADING_DASH_RE, "")
    .replace(TRAILING_DASH_RE, "")
    .slice(0, 64);
  return normalized || fallback;
}

function normalizeAgentId(value: string | undefined | null): string {
  return normalizeSegment(value, DEFAULT_AGENT_ID);
}

function resolveIdentityLink(params: {
  identityLinks?: SessionIdentityLinks;
  channel: string;
  peerId: string;
}): string | undefined {
  const { identityLinks } = params;
  if (!identityLinks) {
    return undefined;
  }

  const normalizedChannel = normalizeSegment(params.channel, DEFAULT_CHANNEL);
  const normalizedPeer = normalizeSegment(params.peerId, DEFAULT_PEER);
  const lookup = `${normalizedChannel}:${normalizedPeer}`;

  for (const [canonical, entries] of Object.entries(identityLinks)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      const trimmed = String(entry ?? "").trim();
      if (!trimmed) {
        continue;
      }
      const [rawProvider, rawPeer] = trimmed.split(":", 2);
      if (!rawProvider || !rawPeer) {
        continue;
      }
      const provider = normalizeSegment(rawProvider, DEFAULT_CHANNEL);
      const peer = normalizeSegment(rawPeer, DEFAULT_PEER);
      if (!provider || !peer) {
        continue;
      }
      if (`${provider}:${peer}` === lookup) {
        const normalizedCanonical = normalizeSegment(canonical, normalizedPeer);
        return normalizedCanonical || normalizedPeer;
      }
    }
  }

  return undefined;
}

export function buildSessionKey(params: {
  agentId: string;
  message: InboundMessage;
  dmScope?: DmScope;
  mainKey?: string;
  identityLinks?: SessionIdentityLinks;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeSegment(params.mainKey, DEFAULT_MAIN_KEY);
  const channel = normalizeSegment(params.message.channel, DEFAULT_CHANNEL);
  const peerKind = params.message.peerType ?? "dm";
  let peerId = normalizeSegment(params.message.peerId, DEFAULT_PEER);
  const accountId = normalizeSegment(params.message.accountId, DEFAULT_ACCOUNT_ID);
  const dmScope = params.dmScope ?? "per-channel-peer";

  if (peerKind === "dm") {
    const linked = resolveIdentityLink({
      identityLinks: params.identityLinks,
      channel,
      peerId,
    });
    if (linked) {
      peerId = linked;
    }
  }

  let baseKey: string;
  if (peerKind === "dm") {
    if (dmScope === "main") {
      baseKey = `agent:${agentId}:${mainKey}`;
    } else if (dmScope === "per-peer") {
      baseKey = `agent:${agentId}:dm:${peerId}`;
    } else if (dmScope === "per-account-channel-peer") {
      baseKey = `agent:${agentId}:${channel}:${accountId}:dm:${peerId}`;
    } else {
      baseKey = `agent:${agentId}:${channel}:dm:${peerId}`;
    }
  } else {
    baseKey = `agent:${agentId}:${channel}:${peerKind}:${peerId}`;
  }

  const threadId = normalizeSegment(params.message.threadId, "");
  if (!threadId) {
    return baseKey;
  }
  return `${baseKey}:thread:${threadId}`;
}

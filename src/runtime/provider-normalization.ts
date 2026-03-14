const PROVIDER_ALIASES: Record<string, string> = {
  "z.ai": "zai",
  "z-ai": "zai",
  "opencode-zen": "opencode",
  qwen: "qwen-portal",
  "kimi-code": "kimi-coding",
  bedrock: "amazon-bedrock",
  "aws-bedrock": "amazon-bedrock",
  bytedance: "volcengine",
  doubao: "volcengine",
};

export function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

export function normalizeProviderIdForAuth(provider: string): string {
  const normalized = normalizeProviderId(provider);
  if (normalized === "volcengine-plan") {
    return "volcengine";
  }
  if (normalized === "byteplus-plan") {
    return "byteplus";
  }
  return normalized;
}

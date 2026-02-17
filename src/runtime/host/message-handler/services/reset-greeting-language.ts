const NEW_SESSION_FALLBACK_TEXT_EN = "New session started (rotated to a new session segment).";
const NEW_SESSION_FALLBACK_TEXT_ZH_CN = "新会话已开始（已切换到新的会话分段）。";

const LANGUAGE_FIELD_PATTERN =
  /(?:language\s*preference|preferred\s*language|language|locale|语言偏好|语言)\s*[:：]\s*([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)/i;
const LANGUAGE_CODE_PATTERN = /\b(zh(?:-[A-Za-z0-9]{2,8})?|en(?:-[A-Za-z0-9]{2,8})?)\b/i;

function normalizeLanguageTag(raw: string): string {
  const normalized = raw.trim().replace(/_/g, "-");
  const lower = normalized.toLowerCase();
  if (lower === "zh" || lower.startsWith("zh-")) {
    if (lower === "zh-cn" || lower === "zh-hans") {
      return "zh-CN";
    }
    return "zh";
  }
  if (lower === "en" || lower.startsWith("en-")) {
    return "en";
  }
  return normalized;
}

export function normalizeIdentityLanguageHint(hint: string | null | undefined): string | null {
  if (typeof hint !== "string") {
    return null;
  }
  const trimmed = hint.trim();
  if (!trimmed) {
    return null;
  }
  return normalizeLanguageTag(trimmed);
}

export function extractIdentityLanguageHintFromSystemPrompt(
  systemPrompt: string | null | undefined,
): string | null {
  if (!systemPrompt || !systemPrompt.trim()) {
    return null;
  }
  const identitySliceMatch = systemPrompt.match(/# Identity & Persona([\s\S]*?)(?:\n# |\s*$)/i);
  const identitySlice = identitySliceMatch?.[1] ?? systemPrompt;

  const languageFieldMatch = identitySlice.match(LANGUAGE_FIELD_PATTERN);
  if (languageFieldMatch?.[1]) {
    return normalizeLanguageTag(languageFieldMatch[1]);
  }

  if (/(默认|首选|优先|preferred|preference)/i.test(identitySlice)) {
    if (/(简体中文|中文)/i.test(identitySlice)) {
      return "zh-CN";
    }
    if (/(english|英文)/i.test(identitySlice)) {
      return "en";
    }
  }

  const languageCodeMatch = identitySlice.match(LANGUAGE_CODE_PATTERN);
  if (languageCodeMatch?.[1]) {
    return normalizeLanguageTag(languageCodeMatch[1]);
  }

  return null;
}

export function selectNewSessionFallbackText(
  identityLanguageHint: string | null | undefined,
): string {
  const normalized = normalizeIdentityLanguageHint(identityLanguageHint);
  if (normalized?.startsWith("zh")) {
    return NEW_SESSION_FALLBACK_TEXT_ZH_CN;
  }
  return NEW_SESSION_FALLBACK_TEXT_EN;
}

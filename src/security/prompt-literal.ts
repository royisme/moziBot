/**
 * Sanitize untrusted strings before embedding them as prompt literals.
 *
 * We intentionally strip control/format code points so dynamic fields
 * (paths, ids, metadata) cannot break prompt structure via hidden chars.
 */
export function sanitizePromptLiteral(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "");
}

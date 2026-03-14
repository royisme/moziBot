/**
 * Compatibility adapter for Codex CLI-backed auth checks.
 */

import pc from "picocolors";
import { readCodexCliCredentials, type CodexCliCredential } from "../runtime/cli-credentials";

export type OAuthCredentials = CodexCliCredential;
export type ProviderAuthExecutionOptions = {
  baseDir?: string;
  isRemote?: boolean;
};

export async function loginOpenAICodexOAuth(
  _options?: ProviderAuthExecutionOptions,
): Promise<OAuthCredentials | null> {
  const credentials = readCodexCliCredentials();
  if (credentials) {
    return credentials;
  }

  console.log(pc.yellow("Codex CLI credentials not found."));
  console.log(pc.dim("Run `codex` to authenticate, then retry mozi."));
  return null;
}

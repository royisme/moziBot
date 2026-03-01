/**
 * Codex OAuth login command for moziBot.
 *
 * Authenticates with OpenAI's Codex service via OAuth and stores credentials
 * in the pi-coding-agent auth.json file so the agent runtime can use them.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loginOpenAICodex, type OAuthCredentials } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import pc from "picocolors";

const PROVIDER_ID = "openai-codex";

/** Resolve the pi-agent directory based on config baseDir. */
function resolvePiAgentDir(baseDir?: string): string {
  const base = baseDir ?? path.join(os.homedir(), ".mozi");
  return path.join(base, "pi-agent");
}

/** Open a URL in the system default browser without shell injection risk. */
function openBrowser(url: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let cmd: string;
    let args: string[];

    if (process.platform === "darwin") {
      cmd = "open";
      args = [url];
    } else if (process.platform === "win32") {
      // On Windows, `start` is a shell built-in, so we use cmd.exe
      cmd = "cmd.exe";
      args = ["/c", "start", "", url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }

    execFile(cmd, args, (err) => {
      if (err) {
        console.log(pc.dim(`Could not open browser automatically: ${err.message}`));
      }
      resolve();
    });
  });
}

/**
 * Prompt the user for a line of text via stdin.
 */
async function promptLine(question: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Initiate OpenAI Codex OAuth login flow and persist the credentials.
 *
 * @param options.baseDir  - Mozi base directory (defaults to ~/.mozi)
 * @param options.isRemote - When true, prints the URL instead of opening a browser
 *                           and prompts the user to paste the redirect URL.
 * @returns The OAuth credentials, or null if the user aborted.
 */
export async function loginOpenAICodexOAuth(options?: {
  baseDir?: string;
  isRemote?: boolean;
}): Promise<OAuthCredentials | null> {
  const isRemote = options?.isRemote ?? false;
  const piAgentDir = resolvePiAgentDir(options?.baseDir);

  console.log();
  if (isRemote) {
    console.log(pc.bold("OpenAI Codex OAuth — Remote Mode"));
    console.log(pc.dim("A URL will be shown. Open it in your LOCAL browser."));
    console.log(pc.dim("After signing in, paste the redirect URL back here."));
  } else {
    console.log(pc.bold("OpenAI Codex OAuth"));
    console.log(pc.dim("Your browser will open for OpenAI authentication."));
    console.log(
      pc.dim("If the callback does not auto-complete, paste the redirect URL when prompted."),
    );
    console.log(pc.dim("OpenAI OAuth uses localhost:1455 for the callback."));
  }
  console.log();

  // In remote mode we collect the redirect URL during onAuth and reuse it in onPrompt.
  let pendingManualCode: Promise<string> | undefined;

  const onAuth = async (info: { url: string; instructions?: string }) => {
    const { url, instructions } = info;
    if (isRemote) {
      console.log(pc.bold("\nOpen this URL in your LOCAL browser:\n"));
      console.log(pc.cyan(url));
      console.log();
      if (instructions) {
        console.log(pc.dim(instructions));
      }
      // Start collecting input; onPrompt will reuse the same promise.
      pendingManualCode = promptLine(pc.bold("Paste the redirect URL: "));
    } else {
      process.stdout.write(pc.dim("Opening browser…\n"));
      if (instructions) {
        console.log(pc.dim(instructions));
      }
      await openBrowser(url);
      console.log(pc.dim(`Auth URL: ${url}`));
    }
  };

  const onPrompt = async (prompt: { message: string; placeholder?: string }): Promise<string> => {
    if (pendingManualCode) {
      return pendingManualCode;
    }
    const message = prompt.placeholder
      ? `${prompt.message} (${prompt.placeholder}): `
      : `${prompt.message}: `;
    return promptLine(pc.bold(message));
  };

  process.stdout.write(pc.dim("Starting OAuth flow… "));

  let creds: OAuthCredentials;
  try {
    creds = await loginOpenAICodex({
      onAuth,
      onPrompt,
      onProgress: (msg) => {
        process.stdout.write(`\r${pc.dim(msg.padEnd(60))}`);
      },
    });
  } catch (err) {
    process.stdout.write("\n");
    console.log(pc.red("OpenAI OAuth failed"));
    console.error(pc.red(String(err)));
    console.log(pc.dim("Trouble with OAuth? Visit https://help.openai.com"));
    throw err;
  }

  process.stdout.write(`\r${pc.green("OpenAI OAuth complete".padEnd(60))}\n`);

  // Persist credentials using pi-coding-agent AuthStorage — the same file used at runtime.
  await fs.mkdir(piAgentDir, { recursive: true });
  const authPath = path.join(piAgentDir, "auth.json");
  const authStorage = AuthStorage.create(authPath);
  authStorage.set(PROVIDER_ID, { type: "oauth", ...creds });

  console.log();
  console.log(pc.green(`Credentials saved to ${authPath}`));
  console.log(
    pc.dim(
      `The ${pc.bold(PROVIDER_ID)} provider is now available. ` +
        `Use model ${pc.bold(`${PROVIDER_ID}/gpt-5.3-codex`)} in your config.`,
    ),
  );
  console.log();

  return creds;
}

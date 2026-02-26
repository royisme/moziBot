import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoCompleteBootstrapIfReady, ensureHome, HOME_FILES } from "./home";

describe("home bootstrap auto completion", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-home-"));
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it("does not complete when templates are unchanged", async () => {
    await ensureHome(homeDir);
    const completed = await autoCompleteBootstrapIfReady(homeDir);

    expect(completed).toBe(false);
    await expect(fs.access(path.join(homeDir, HOME_FILES.BOOTSTRAP))).resolves.toBeUndefined();

    const stateRaw = await fs.readFile(path.join(homeDir, "home-state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as {
      bootstrapSeededAt?: string;
      onboardingCompletedAt?: string;
    };
    expect(state.bootstrapSeededAt).toBeTruthy();
    expect(state.onboardingCompletedAt).toBeUndefined();
  });

  it("completes when identity/user/soul differ from templates", async () => {
    await ensureHome(homeDir);

    const identityPath = path.join(homeDir, HOME_FILES.IDENTITY);
    const userPath = path.join(homeDir, HOME_FILES.USER);
    const soulPath = path.join(homeDir, HOME_FILES.SOUL);

    await fs.writeFile(identityPath, `${await fs.readFile(identityPath, "utf-8")}\nupdated`);
    await fs.writeFile(userPath, `${await fs.readFile(userPath, "utf-8")}\nupdated`);
    await fs.writeFile(soulPath, `${await fs.readFile(soulPath, "utf-8")}\nupdated`);

    const completed = await autoCompleteBootstrapIfReady(homeDir);

    expect(completed).toBe(true);
    await expect(fs.access(path.join(homeDir, HOME_FILES.BOOTSTRAP))).rejects.toBeTruthy();

    const stateRaw = await fs.readFile(path.join(homeDir, "home-state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as { onboardingCompletedAt?: string };
    expect(state.onboardingCompletedAt).toBeTruthy();
  });
});

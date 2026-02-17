import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./loader";

const ENV_KEY = "MOZI_LOADER_TEST_KEY";
const ORIGINAL_ENV = process.env[ENV_KEY];
const tempDirs: string[] = [];

function createConfigDir(): { dir: string; configPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-loader-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "config.jsonc");
  const config = {
    models: {
      providers: {
        quotio: {
          api: "openai-responses",
          apiKey: `\${${ENV_KEY}}`,
          models: [{ id: "gemini-3-flash-preview" }],
        },
      },
    },
    agents: {
      defaults: { model: "quotio/gemini-3-flash-preview" },
      mozi: { main: true, sandbox: { mode: "off" } },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return { dir, configPath };
}

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = ORIGINAL_ENV;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("config loader local .env support", () => {
  it("uses configured baseDir when defaulting sessions and logs", () => {
    const { configPath } = createConfigDir();
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    parsed.paths = { baseDir: "/tmp/mozi-base" };
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), "utf-8");

    const result = loadConfig(configPath);

    expect(result.success).toBe(true);
    expect(result.config?.paths?.baseDir).toBe("/tmp/mozi-base");
    expect(result.config?.paths?.sessions).toBe("/tmp/mozi-base/sessions");
    expect(result.config?.paths?.logs).toBe("/tmp/mozi-base/logs");
  });

  it("expands ~ for path-like config entries", () => {
    const { configPath } = createConfigDir();
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    parsed.paths = {
      baseDir: "~/.mozi",
      skills: "~/.mozi/skills",
    };
    parsed.agents = {
      defaults: { model: "quotio/gemini-3-flash-preview" },
      mozi: {
        main: true,
        home: "~/agents/home",
        workspace: "~/agents/workspace",
      },
    };
    parsed.skills = {
      dirs: ["~/.mozi/skills"],
      installDir: "~/.mozi/skills",
    };
    parsed.extensions = {
      enabled: true,
      load: {
        paths: ["~/.mozi/extensions"],
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), "utf-8");

    const result = loadConfig(configPath);

    expect(result.success).toBe(true);
    expect(result.config?.paths?.baseDir).toBe(path.join(os.homedir(), ".mozi"));
    expect(result.config?.paths?.skills).toBe(path.join(os.homedir(), ".mozi", "skills"));
    expect(result.config?.agents?.mozi?.home).toBe(path.join(os.homedir(), "agents", "home"));
    expect(result.config?.agents?.mozi?.workspace).toBe(
      path.join(os.homedir(), "agents", "workspace"),
    );
    expect(result.config?.skills?.installDir).toBe(path.join(os.homedir(), ".mozi", "skills"));
    expect(result.config?.skills?.dirs?.[0]).toBe(path.join(os.homedir(), ".mozi", "skills"));
    expect(result.config?.extensions?.load?.paths?.[0]).toBe(
      path.join(os.homedir(), ".mozi", "extensions"),
    );
  });

  it("defaults logging level to info when logging section is missing", () => {
    delete process.env[ENV_KEY];
    const { dir, configPath } = createConfigDir();
    fs.writeFileSync(path.join(dir, ".env"), `${ENV_KEY}=from-dotenv\n`, "utf-8");

    const result = loadConfig(configPath);

    expect(result.success).toBe(true);
    expect(result.config?.logging?.level).toBe("info");
  });

  it("keeps explicit logging level from config", () => {
    delete process.env[ENV_KEY];
    const { dir, configPath } = createConfigDir();
    fs.writeFileSync(path.join(dir, ".env"), `${ENV_KEY}=from-dotenv\n`, "utf-8");
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    parsed.logging = { level: "debug" };
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), "utf-8");

    const result = loadConfig(configPath);

    expect(result.success).toBe(true);
    expect(result.config?.logging?.level).toBe("debug");
  });

  it("loads .env from config directory for env placeholders", () => {
    delete process.env[ENV_KEY];
    const { dir, configPath } = createConfigDir();
    fs.writeFileSync(path.join(dir, ".env"), `${ENV_KEY}=from-dotenv\n`, "utf-8");

    const result = loadConfig(configPath);

    expect(result.success).toBe(true);
    expect(result.config?.models?.providers?.quotio?.apiKey).toBe("from-dotenv");
  });

  it("does not override existing process env with config-local .env", () => {
    process.env[ENV_KEY] = "from-process";
    const { dir, configPath } = createConfigDir();
    fs.writeFileSync(path.join(dir, ".env"), `${ENV_KEY}=from-dotenv\n`, "utf-8");

    const result = loadConfig(configPath);

    expect(result.success).toBe(true);
    expect(result.config?.models?.providers?.quotio?.apiKey).toBe("from-process");
  });

  it("loads .env.var from config directory for env placeholders", () => {
    delete process.env[ENV_KEY];
    const { dir, configPath } = createConfigDir();
    fs.writeFileSync(path.join(dir, ".env.var"), `${ENV_KEY}=from-dotenv-var\n`, "utf-8");

    const result = loadConfig(configPath);

    expect(result.success).toBe(true);
    expect(result.config?.models?.providers?.quotio?.apiKey).toBe("from-dotenv-var");
  });

  it("does not override existing process env with config-local .env.var", () => {
    process.env[ENV_KEY] = "from-process";
    const { dir, configPath } = createConfigDir();
    fs.writeFileSync(path.join(dir, ".env.var"), `${ENV_KEY}=from-dotenv-var\n`, "utf-8");

    const result = loadConfig(configPath);

    expect(result.success).toBe(true);
    expect(result.config?.models?.providers?.quotio?.apiKey).toBe("from-process");
  });

  it("keeps unresolved env placeholder instead of hard failing", () => {
    delete process.env[ENV_KEY];
    const { configPath } = createConfigDir();

    const result = loadConfig(configPath);

    expect(result.success).toBe(true);
    expect(result.config?.models?.providers?.quotio?.apiKey).toBe(`\${${ENV_KEY}}`);
  });
});

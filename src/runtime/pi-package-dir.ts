import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_VERSION } from "../version";

/**
 * pi-coding-agent reads package assets from PI_PACKAGE_DIR during module init.
 * For compiled binaries, ensure this points to a directory containing package.json.
 */
export function ensurePiPackageDir() {
  if (process.env.PI_PACKAGE_DIR) {
    return;
  }

  const candidates: string[] = [];
  const execDir = path.dirname(process.execPath);
  candidates.push(execDir);
  candidates.push(path.resolve(execDir, ".."));
  candidates.push(process.cwd());

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      process.env.PI_PACKAGE_DIR = dir;
      return;
    }
  }

  const fallbackDir = path.join(os.homedir(), ".mozi", "pi-package");
  const fallbackPkgPath = path.join(fallbackDir, "package.json");
  if (!fs.existsSync(fallbackPkgPath)) {
    fs.mkdirSync(fallbackDir, { recursive: true });
    fs.writeFileSync(
      fallbackPkgPath,
      JSON.stringify(
        {
          name: "mozi-runtime",
          version: APP_VERSION,
          piConfig: { name: "pi", configDir: ".pi" },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }
  process.env.PI_PACKAGE_DIR = fallbackDir;
}

ensurePiPackageDir();

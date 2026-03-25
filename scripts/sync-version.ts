import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const versionFile = resolve(root, "src/version.ts");
const content = `export const APP_VERSION = ${JSON.stringify(pkg.version)};\n`;

const existing = readFileSync(versionFile, "utf8");
if (existing !== content) {
  writeFileSync(versionFile, content, "utf8");
  console.log(`[sync-version] Updated src/version.ts to ${pkg.version}`);
} else {
  console.log(`[sync-version] src/version.ts already at ${pkg.version}`);
}

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

type PackEntry = {
  path: string;
};

type PackageJson = {
  version?: string;
  bin?: Record<string, string>;
};

const root = process.cwd();
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;

if (!pkg.version) {
  console.error("release-check: package.json version is missing.");
  process.exit(1);
}

const binPath = pkg.bin?.mozi;
if (!binPath) {
  console.error("release-check: package.json bin.mozi is missing.");
  process.exit(1);
}

const output = execSync("npm pack --dry-run --json --ignore-scripts", {
  cwd: root,
  encoding: "utf-8",
});

const parsed = JSON.parse(output) as Array<{ files?: PackEntry[] }>;
const files = parsed[0]?.files ?? [];
const packed = new Set(files.map((entry) => entry.path));

const required = [
  "package.json",
  "README.md",
  binPath.replace(/^\.\//, ""),
  "dist/mozi-runtime.mjs",
];

const missing = required.filter((file) => !packed.has(file));
if (missing.length > 0) {
  console.error("release-check: missing required files in npm pack:");
  for (const item of missing) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

const forbiddenPatterns = ["src/", ".extLibs/", "sessions/", "data/", "docs/"];

const forbidden = Array.from(packed).filter((entry) =>
  forbiddenPatterns.some((prefix) => entry.startsWith(prefix)),
);

if (forbidden.length > 0) {
  console.error("release-check: forbidden files present in npm pack:");
  for (const item of forbidden) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

console.log("release-check: npm pack contents look good.");

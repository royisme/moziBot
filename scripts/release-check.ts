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

function resolveTagVersion(): string | null {
  const refName = process.env.GITHUB_REF_NAME;
  if (refName) {
    return normalizeTag(refName);
  }
  const ref = process.env.GITHUB_REF;
  if (!ref) {
    return null;
  }
  const match = ref.match(/refs\/tags\/(.+)$/);
  if (!match) {
    return null;
  }
  return normalizeTag(match[1]);
}

function normalizeTag(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const version = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  const semver =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version) ??
    /^(\d+)\.(\d+)\.(\d+)\+([0-9A-Za-z.-]+)$/.exec(version);
  if (!semver) {
    return null;
  }
  return version;
}

const tagVersion = resolveTagVersion();
if (tagVersion && tagVersion !== pkg.version) {
  console.error(
    `release-check: tag version ${tagVersion} does not match package.json ${pkg.version}.`,
  );
  console.error("release-check: run scripts/release.sh or sync package.json before tagging.");
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

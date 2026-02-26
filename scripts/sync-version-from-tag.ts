import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type PackageJson = {
  version?: string;
};

const root = process.cwd();
const pkgPath = path.join(root, "package.json");

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

const versionFromTag = resolveTagVersion();
if (!versionFromTag) {
  console.log("sync-version: no valid tag found, skipping.");
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;
const currentVersion = pkg.version?.trim();

if (!currentVersion) {
  console.error("sync-version: package.json version is missing.");
  process.exit(1);
}

if (currentVersion !== versionFromTag) {
  pkg.version = versionFromTag;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  console.log(`sync-version: package.json ${currentVersion} -> ${versionFromTag}`);
} else {
  console.log(`sync-version: package.json already at ${currentVersion}`);
}

const versionFilePath = path.join(root, "src", "version.ts");
const versionSource = `export const APP_VERSION = "${versionFromTag}";\n`;
writeFileSync(versionFilePath, versionSource, "utf-8");
console.log(`sync-version: wrote src/version.ts ${versionFromTag}`);

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(rootDir, "src", "agents", "templates");
const distDir = path.join(rootDir, "dist", "templates");

async function run() {
  await fs.mkdir(distDir, { recursive: true });
  await fs.cp(srcDir, distDir, { recursive: true });
}

run().catch((err) => {
  console.error("Failed to copy templates:", err);
  process.exitCode = 1;
});

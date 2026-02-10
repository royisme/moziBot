import "../pi-package-dir";
import { RuntimeHost } from "./index";

const runtime = new RuntimeHost();

process.on("SIGINT", async () => {
  await runtime.stop();
});

process.on("SIGTERM", async () => {
  await runtime.stop();
});

await runtime.start();

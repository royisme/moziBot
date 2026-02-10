import { expect, test } from "vitest";
import { buildContainerConfig, buildMounts, parseMountSpec } from "./service";

test("buildMounts includes workspace mount", () => {
  const mounts = buildMounts({
    workspaceDir: "/tmp/workspace",
    workspaceAccess: "ro",
    extraMounts: [],
  });
  expect(mounts.length).toBe(1);
  expect(mounts[0]?.readonly).toBe(true);
});

test("parseMountSpec supports ro suffix", () => {
  const mount = parseMountSpec("/src:/target:ro");
  expect(mount?.source).toBe("/src");
  expect(mount?.target).toBe("/target");
  expect(mount?.readonly).toBe(true);
});

test("buildContainerConfig maps fields", () => {
  const config = buildContainerConfig({
    backend: "docker",
    image: "mozi-sandbox-common:bun1.3",
    workdir: "/workspace",
    env: { FOO: "bar" },
    mounts: [{ source: "/src", target: "/workspace", readonly: false }],
  });
  expect(config.image).toBe("mozi-sandbox-common:bun1.3");
  expect(config.backend).toBe("docker");
  expect(config.workdir).toBe("/workspace");
  expect(config.env?.FOO).toBe("bar");
  expect(config.mounts?.length).toBe(1);
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isProcessRunning, Lifecycle } from "./lifecycle";

const PID_FILE = path.resolve(process.cwd(), "data/mozi.pid");

describe("Runtime Lifecycle", () => {
  beforeEach(() => {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  });

  afterEach(() => {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  });

  test("writePid creates a pid file", () => {
    Lifecycle.writePid();
    expect(fs.existsSync(PID_FILE)).toBe(true);
    const content = fs.readFileSync(PID_FILE, "utf8");
    expect(content).toBe(process.pid.toString());
  });

  test("removePid removes the pid file if it matches current process", () => {
    Lifecycle.writePid();
    expect(fs.existsSync(PID_FILE)).toBe(true);
    Lifecycle.removePid();
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  test("removePid does not remove the pid file if it belongs to another process", () => {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, "999999", "utf8");
    Lifecycle.removePid();
    expect(fs.existsSync(PID_FILE)).toBe(true);
    expect(fs.readFileSync(PID_FILE, "utf8")).toBe("999999");
  });

  test("checkExisting detects running process", () => {
    Lifecycle.writePid();
    expect(Lifecycle.checkExisting()).toBe(true);
  });

  test("checkExisting cleans up stale pid file", () => {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    // Use a PID that is highly unlikely to be running
    fs.writeFileSync(PID_FILE, "999998", "utf8");

    // Note: there is a tiny chance 999998 is running, but usually safe for tests
    if (!isProcessRunning(999998)) {
      expect(Lifecycle.checkExisting()).toBe(false);
      expect(fs.existsSync(PID_FILE)).toBe(false);
    }
  });

  test("writePid throws if already running", () => {
    Lifecycle.writePid();
    expect(() => Lifecycle.writePid()).toThrow("Runtime is already running");
  });
});

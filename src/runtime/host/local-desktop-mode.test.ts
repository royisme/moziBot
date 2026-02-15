import { describe, expect, it } from "vitest";
import { resolveLocalDesktopDecision } from "./local-desktop-mode";

describe("resolveLocalDesktopDecision", () => {
  it("defaults to auto mode and enables on desktop environments", () => {
    const decision = resolveLocalDesktopDecision(
      {},
      {
        platform: "darwin",
        env: {},
      },
    );

    expect(decision.mode).toBe("auto");
    expect(decision.source).toBe("default");
    expect(decision.enabled).toBe(true);
  });

  it("defaults to auto mode and disables in linux headless", () => {
    const decision = resolveLocalDesktopDecision(
      {},
      {
        platform: "linux",
        env: {},
      },
    );

    expect(decision.mode).toBe("auto");
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain("No DISPLAY/WAYLAND_DISPLAY");
  });

  it("honors config widget mode off", () => {
    const decision = resolveLocalDesktopDecision(
      {
        channels: {
          localDesktop: {
            widget: {
              mode: "off",
            },
          },
        },
      },
      {
        platform: "darwin",
        env: {},
      },
    );

    expect(decision.mode).toBe("off");
    expect(decision.source).toBe("config");
    expect(decision.enabled).toBe(false);
  });

  it("honors env override over config", () => {
    const decision = resolveLocalDesktopDecision(
      {
        channels: {
          localDesktop: {
            widget: {
              mode: "off",
            },
          },
        },
      },
      {
        platform: "linux",
        env: {
          MOZI_WIDGET_MODE: "on",
        },
      },
    );

    expect(decision.mode).toBe("on");
    expect(decision.source).toBe("env");
    expect(decision.enabled).toBe(true);
  });

  it("keeps backward compatibility with legacy enabled false", () => {
    const decision = resolveLocalDesktopDecision(
      {
        channels: {
          localDesktop: {
            enabled: false,
          },
        },
      },
      {
        platform: "darwin",
        env: {},
      },
    );

    expect(decision.mode).toBe("off");
    expect(decision.source).toBe("legacy-enabled");
    expect(decision.enabled).toBe(false);
  });
});

import type { ExtensionCapabilities, ExtensionDiagnostic, ExtensionManifest } from "./types";

/**
 * Validate an extension manifest object for required fields and structure.
 * Returns diagnostics for any issues found.
 */
export function validateManifest(
  raw: unknown,
  source: string,
): { manifest: ExtensionManifest | null; diagnostics: ExtensionDiagnostic[] } {
  const diagnostics: ExtensionDiagnostic[] = [];

  if (!raw || typeof raw !== "object") {
    diagnostics.push({
      extensionId: "unknown",
      level: "error",
      message: `Invalid extension manifest from ${source}: not an object`,
    });
    return { manifest: null, diagnostics };
  }

  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : "";
  const extId = id || "unknown";

  if (!id) {
    diagnostics.push({
      extensionId: extId,
      level: "error",
      message: `Extension from ${source} is missing required field: id`,
    });
    return { manifest: null, diagnostics };
  }

  if (typeof obj.version !== "string" || !obj.version) {
    diagnostics.push({
      extensionId: extId,
      level: "error",
      message: `Extension "${extId}" is missing required field: version`,
    });
    return { manifest: null, diagnostics };
  }

  if (typeof obj.name !== "string" || !obj.name) {
    diagnostics.push({
      extensionId: extId,
      level: "error",
      message: `Extension "${extId}" is missing required field: name`,
    });
    return { manifest: null, diagnostics };
  }

  const tools = Array.isArray(obj.tools) ? obj.tools : [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      diagnostics.push({
        extensionId: extId,
        level: "error",
        message: `Extension "${extId}" has invalid tool entry: not an object`,
      });
      return { manifest: null, diagnostics };
    }
    const t = tool as Record<string, unknown>;
    if (typeof t.name !== "string" || !t.name) {
      diagnostics.push({
        extensionId: extId,
        level: "error",
        message: `Extension "${extId}" has a tool missing required field: name`,
      });
      return { manifest: null, diagnostics };
    }
    if (typeof t.execute !== "function") {
      diagnostics.push({
        extensionId: extId,
        level: "error",
        message: `Extension "${extId}" tool "${t.name}" is missing execute function`,
      });
      return { manifest: null, diagnostics };
    }
  }

  const commands = Array.isArray(obj.commands) ? obj.commands : [];
  for (const command of commands) {
    if (!command || typeof command !== "object") {
      diagnostics.push({
        extensionId: extId,
        level: "error",
        message: `Extension "${extId}" has invalid command entry: not an object`,
      });
      return { manifest: null, diagnostics };
    }
    const c = command as Record<string, unknown>;
    if (typeof c.name !== "string" || !c.name.trim()) {
      diagnostics.push({
        extensionId: extId,
        level: "error",
        message: `Extension "${extId}" has a command missing required field: name`,
      });
      return { manifest: null, diagnostics };
    }
    if (typeof c.description !== "string" || !c.description.trim()) {
      diagnostics.push({
        extensionId: extId,
        level: "error",
        message: `Extension "${extId}" command "${c.name}" is missing required field: description`,
      });
      return { manifest: null, diagnostics };
    }
    if (typeof c.handler !== "function") {
      diagnostics.push({
        extensionId: extId,
        level: "error",
        message: `Extension "${extId}" command "${c.name}" is missing handler function`,
      });
      return { manifest: null, diagnostics };
    }
  }

  const hooks = Array.isArray(obj.hooks) ? obj.hooks : [];
  for (const hook of hooks) {
    if (!hook || typeof hook !== "object") {
      diagnostics.push({
        extensionId: extId,
        level: "error",
        message: `Extension "${extId}" has invalid hook entry: not an object`,
      });
      return { manifest: null, diagnostics };
    }
    const h = hook as Record<string, unknown>;
    if (typeof h.hookName !== "string" || !h.hookName.trim()) {
      diagnostics.push({
        extensionId: extId,
        level: "error",
        message: `Extension "${extId}" has a hook missing required field: hookName`,
      });
      return { manifest: null, diagnostics };
    }
    if (typeof h.handler !== "function") {
      diagnostics.push({
        extensionId: extId,
        level: "error",
        message: `Extension "${extId}" hook "${h.hookName}" is missing handler function`,
      });
      return { manifest: null, diagnostics };
    }
  }

  if (
    tools.length === 0 &&
    commands.length === 0 &&
    hooks.length === 0 &&
    typeof obj.register !== "function"
  ) {
    diagnostics.push({
      extensionId: extId,
      level: "warn",
      message: `Extension "${extId}" exports no tools/commands/hooks/register callback`,
    });
  }

  // Validate capabilities shape if present
  let capabilities: ExtensionCapabilities | undefined;
  if (obj.capabilities !== undefined) {
    if (
      !obj.capabilities ||
      typeof obj.capabilities !== "object" ||
      Array.isArray(obj.capabilities)
    ) {
      diagnostics.push({
        extensionId: extId,
        level: "warn",
        message: `Extension "${extId}" has invalid capabilities declaration: not an object`,
      });
    } else {
      const cap = obj.capabilities as Record<string, unknown>;
      capabilities = {};
      const allowedKeys = new Set(["tools", "commands", "hooks"]);
      for (const key of Object.keys(cap)) {
        if (!allowedKeys.has(key)) {
          diagnostics.push({
            extensionId: extId,
            level: "warn",
            message: `Extension "${extId}" has unknown capabilities key "${key}"`,
          });
        }
      }
      for (const key of ["tools", "commands", "hooks"] as const) {
        if (key in cap) {
          if (typeof cap[key] !== "boolean") {
            diagnostics.push({
              extensionId: extId,
              level: "warn",
              message: `Extension "${extId}" capabilities.${key} should be boolean, got ${typeof cap[key]}`,
            });
          } else {
            capabilities[key] = cap[key];
          }
        }
      }
    }
  }

  // Validate lifecycle signatures if present
  for (const lcName of ["onStart", "onStop", "onReload"] as const) {
    if (obj[lcName] !== undefined && typeof obj[lcName] !== "function") {
      diagnostics.push({
        extensionId: extId,
        level: "warn",
        message: `Extension "${extId}" ${lcName} should be a function, got ${typeof obj[lcName]}`,
      });
    }
  }

  const manifest: ExtensionManifest = {
    id: obj.id as string,
    version: obj.version,
    name: obj.name,
    description: typeof obj.description === "string" ? obj.description : undefined,
    configSchema: obj.configSchema as ExtensionManifest["configSchema"],
    tools: tools as ExtensionManifest["tools"],
    commands: commands as ExtensionManifest["commands"],
    hooks: hooks as ExtensionManifest["hooks"],
    register: typeof obj.register === "function" ? obj.register : undefined,
    skillDirs: Array.isArray(obj.skillDirs)
      ? (obj.skillDirs as string[]).filter((d) => typeof d === "string")
      : undefined,
    capabilities,
    onStart:
      typeof obj.onStart === "function" ? (obj.onStart as ExtensionManifest["onStart"]) : undefined,
    onStop:
      typeof obj.onStop === "function" ? (obj.onStop as ExtensionManifest["onStop"]) : undefined,
    onReload:
      typeof obj.onReload === "function"
        ? (obj.onReload as ExtensionManifest["onReload"])
        : undefined,
  };

  return { manifest, diagnostics };
}

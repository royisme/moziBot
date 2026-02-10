import type { ExtensionDiagnostic, ExtensionManifest } from "./types";

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

  if (!Array.isArray(obj.tools)) {
    diagnostics.push({
      extensionId: extId,
      level: "error",
      message: `Extension "${extId}" is missing required field: tools (must be an array)`,
    });
    return { manifest: null, diagnostics };
  }

  // Validate each tool definition has required fields
  for (const tool of obj.tools) {
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

  const manifest: ExtensionManifest = {
    id: obj.id as string,
    version: obj.version,
    name: obj.name,
    description: typeof obj.description === "string" ? obj.description : undefined,
    configSchema: obj.configSchema as ExtensionManifest["configSchema"],
    tools: obj.tools as ExtensionManifest["tools"],
    skillDirs: Array.isArray(obj.skillDirs)
      ? (obj.skillDirs as string[]).filter((d) => typeof d === "string")
      : undefined,
  };

  return { manifest, diagnostics };
}

import { AcpRuntimeError, withAcpRuntimeErrorBoundary } from "../runtime/errors";
import type { AcpRuntime, AcpRuntimeCapabilities, AcpRuntimeHandle } from "../runtime/types";
import type { SessionAcpMeta } from "./manager.types";
import { createUnsupportedControlError } from "./manager.utils";
import type { CachedRuntimeState } from "./runtime-cache";
import {
  buildRuntimeConfigOptionPairs,
  buildRuntimeControlSignature,
  normalizeText,
  resolveRuntimeOptionsFromMeta,
} from "./runtime-options";

export async function resolveManagerRuntimeCapabilities(params: {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
}): Promise<AcpRuntimeCapabilities> {
  let reported: AcpRuntimeCapabilities | undefined;
  if (params.runtime.getCapabilities) {
    reported = await withAcpRuntimeErrorBoundary({
      run: async () => await params.runtime.getCapabilities!({ handle: params.handle }),
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "Could not read ACP runtime capabilities.",
    });
  }
  const controls = new Set<AcpRuntimeCapabilities["controls"][number]>(reported?.controls ?? []);
  if (params.runtime.setMode) {
    controls.add("session/set_mode");
  }
  if (params.runtime.setConfigOption) {
    controls.add("session/set_config_option");
  }
  if (params.runtime.getStatus) {
    controls.add("session/status");
  }
  const legacyConfigOptionKeys = (reported as { config_option_keys?: unknown } | undefined)
    ?.config_option_keys;
  const normalizedKeys = [
    ...(reported?.configOptionKeys ?? []),
    ...(Array.isArray(legacyConfigOptionKeys) ? legacyConfigOptionKeys : []),
  ]
    .map((entry) => normalizeText(entry))
    .filter(Boolean) as string[];
  return {
    controls: [...controls].toSorted(),
    ...(normalizedKeys.length > 0 ? { configOptionKeys: normalizedKeys } : {}),
  };
}

export async function applyManagerRuntimeControls(params: {
  sessionKey: string;
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  meta: SessionAcpMeta;
  getCachedRuntimeState: (sessionKey: string) => CachedRuntimeState | null;
}): Promise<void> {
  const options = resolveRuntimeOptionsFromMeta(params.meta);
  const signature = buildRuntimeControlSignature(options);
  const cached = params.getCachedRuntimeState(params.sessionKey);
  if (cached?.appliedControlSignature === signature) {
    return;
  }

  const capabilities = await resolveManagerRuntimeCapabilities({
    runtime: params.runtime,
    handle: params.handle,
  });
  const backend = params.handle.backend || params.meta.backend;
  const runtimeMode = normalizeText(options.runtimeMode);
  const configOptions = buildRuntimeConfigOptionPairs(options);
  const advertisedKeys = new Set(
    (capabilities.configOptionKeys ?? [])
      .map((entry) => normalizeText(entry))
      .filter(Boolean) as string[],
  );

  await withAcpRuntimeErrorBoundary({
    run: async () => {
      if (runtimeMode) {
        if (!capabilities.controls.includes("session/set_mode") || !params.runtime.setMode) {
          throw createUnsupportedControlError({
            backend,
            control: "session/set_mode",
          });
        }
        await params.runtime.setMode({
          handle: params.handle,
          mode: runtimeMode,
        });
      }

      if (configOptions.length > 0) {
        if (
          !capabilities.controls.includes("session/set_config_option") ||
          !params.runtime.setConfigOption
        ) {
          throw createUnsupportedControlError({
            backend,
            control: "session/set_config_option",
          });
        }
        for (const [key, value] of configOptions) {
          if (advertisedKeys.size > 0 && !advertisedKeys.has(key)) {
            throw new AcpRuntimeError(
              "ACP_BACKEND_UNSUPPORTED_CONTROL",
              `ACP backend "${backend}" does not advertise required config key "${key}" (advertised: ${[...advertisedKeys].toSorted().join(", ")}).`,
            );
          }
          await params.runtime.setConfigOption({
            handle: params.handle,
            key,
            value,
          });
        }
      }
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not apply ACP runtime options before turn execution.",
  });

  if (cached) {
    cached.appliedControlSignature = signature;
  }
}

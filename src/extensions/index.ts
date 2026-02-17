// Side-effect: register all builtin extensions
import "./builtins";

export { ExtensionRegistry } from "./registry";
export { initExtensionsAsync, loadExtensions, registerBuiltinExtension } from "./loader";
export type { BuiltinExtensionFactory } from "./loader";
export type {
  ExtensionCapabilities,
  ExtensionCommandContext,
  ExtensionCommandDefinition,
  ExtensionCommandResult,
  ExtensionConfigSchema,
  ExtensionConfigValidation,
  ExtensionDiagnostic,
  ExtensionHookDefinition,
  ExtensionLifecycleContext,
  ExtensionManifest,
  ExtensionRegisterApi,
  ExtensionToolContext,
  ExtensionToolDefinition,
  LoadedExtension,
} from "./types";

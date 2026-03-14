import type { MoziConfig } from "../config/schema";
import type { SecretManager } from "../storage/secrets/types";

export type { SecretManager } from "../storage/secrets/types";

export interface ConfigureSection {
  name: string;
  label: string;
  description: string;
  order: number;
  run(ctx: WizardContext): Promise<SectionResult>;
  validate?(ctx: WizardContext): Promise<Diagnostic[]>;
}

export interface SectionResult {
  modified: boolean;
  message?: string;
}

export interface Diagnostic {
  level: "error" | "warning" | "info";
  message: string;
}

export interface WizardContext {
  config: MoziConfig;
  configPath: string;
  secrets: SecretManager;
  ui: WizardUI;
  nonInteractive: boolean;
  persist(): Promise<void>;
}

export class WizardCancelledError extends Error {
  constructor(message = "User cancelled") {
    super(message);
    this.name = "WizardCancelledError";
  }
}

export interface WizardUI {
  intro(message: string): void;
  outro(message: string): void;
  text(options: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    validate?: (value: string) => string | void;
    envVar?: string;
  }): Promise<string>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean>;
  select<T>(options: {
    message: string;
    options: Array<{
      value: T;
      label: string;
      hint?: string;
    }>;
  }): Promise<T>;
  multiselect<T>(options: {
    message: string;
    options: Array<{
      value: T;
      label: string;
      hint?: string;
    }>;
    required?: boolean;
  }): Promise<T[]>;
  password(options: {
    message: string;
    validate?: (value: string) => string | void;
    envVar?: string;
  }): Promise<string>;
  spinner(): {
    start(message: string): void;
    stop(message?: string): void;
  };
  note(message: string, title?: string): void;
  warn(message: string): void;
  error(message: string): void;
}

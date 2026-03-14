import { checkbox, confirm, input, password, select } from "@inquirer/prompts";
import pc from "picocolors";
import type { WizardUI } from "./types";
import { WizardCancelledError } from "./types";

type PromptTextOptions = Parameters<WizardUI["text"]>[0] & {
  envVar?: string;
};

type PromptPasswordOptions = Parameters<WizardUI["password"]>[0] & {
  envVar?: string;
};

function isPromptCancelled(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "ExitPromptError" || error.name === "AbortPromptError";
}

function wrapCancellation(error: unknown): never {
  if (isPromptCancelled(error)) {
    throw new WizardCancelledError();
  }

  throw error;
}

function readEnvVarOrThrow(envVar: string): string {
  const value = process.env[envVar];
  if (value === undefined || value.length === 0) {
    throw new Error(`Non-interactive mode requires environment variable ${envVar} to be set.`);
  }

  return value;
}

function printBlock(label: string, message: string, color: (text: string) => string): void {
  console.log(`${color(label)} ${message}`);
}

function createSpinner() {
  let activeMessage: string | undefined;

  return {
    start(message: string): void {
      activeMessage = message;
      printBlock("[... ]", message, pc.cyan);
    },
    stop(message?: string): void {
      const finalMessage = message ?? activeMessage;
      if (finalMessage) {
        printBlock("[done]", finalMessage, pc.green);
      }
      activeMessage = undefined;
    },
  };
}

export function createWizardUI(nonInteractive: boolean): WizardUI {
  return {
    intro(message: string): void {
      console.log(pc.bold(pc.cyan(message)));
    },

    outro(message: string): void {
      console.log(pc.bold(pc.green(message)));
    },

    note(message: string, title?: string): void {
      printBlock(title ? `[note:${title}]` : "[note]", message, pc.blue);
    },

    warn(message: string): void {
      printBlock("[warn]", message, pc.yellow);
    },

    error(message: string): void {
      printBlock("[error]", message, pc.red);
    },

    async text(options: PromptTextOptions): Promise<string> {
      if (nonInteractive) {
        if (options.envVar) {
          return readEnvVarOrThrow(options.envVar);
        }

        throw new Error(`Non-interactive mode requires an envVar for prompt: ${options.message}`);
      }

      try {
        return await input({
          message: options.message,
          default: options.defaultValue,
          validate: options.validate
            ? (value: string) => {
                const result = options.validate?.(value);
                return result === undefined ? true : result;
              }
            : undefined,
        });
      } catch (error: unknown) {
        wrapCancellation(error);
      }
    },

    async confirm(options: { message: string; initialValue?: boolean }): Promise<boolean> {
      if (nonInteractive) {
        return true;
      }

      try {
        return await confirm({
          message: options.message,
          default: options.initialValue,
        });
      } catch (error: unknown) {
        wrapCancellation(error);
      }
    },

    async select<T>(options: {
      message: string;
      options: Array<{
        value: T;
        label: string;
        hint?: string;
      }>;
    }): Promise<T> {
      if (options.options.length === 0) {
        throw new Error(`Select prompt requires at least one option: ${options.message}`);
      }

      if (nonInteractive) {
        return options.options[0].value;
      }

      try {
        return await select<T>({
          message: options.message,
          choices: options.options.map((option) => ({
            value: option.value,
            name: option.label,
            description: option.hint,
          })),
        });
      } catch (error: unknown) {
        wrapCancellation(error);
      }
    },

    async multiselect<T>(options: {
      message: string;
      options: Array<{
        value: T;
        label: string;
        hint?: string;
      }>;
      required?: boolean;
    }): Promise<T[]> {
      if (nonInteractive) {
        const values =
          options.required && options.options.length > 0 ? [options.options[0].value] : [];
        return values;
      }

      try {
        return await checkbox<T>({
          message: options.message,
          choices: options.options.map((option) => ({
            value: option.value,
            name: option.label,
            description: option.hint,
          })),
          validate: (choices: readonly { checked?: boolean }[]) => {
            if (
              options.required &&
              choices.filter((choice: { checked?: boolean }) => choice.checked).length === 0
            ) {
              return "Select at least one option.";
            }
            return true;
          },
        });
      } catch (error: unknown) {
        wrapCancellation(error);
      }
    },

    async password(options: PromptPasswordOptions): Promise<string> {
      if (nonInteractive) {
        if (options.envVar) {
          const value = readEnvVarOrThrow(options.envVar);
          const validationError = options.validate?.(value);
          if (validationError) {
            throw new Error(validationError);
          }
          return value;
        }

        throw new Error(`Non-interactive mode requires an envVar for prompt: ${options.message}`);
      }

      while (true) {
        try {
          const value = await password({
            message: options.message,
            mask: "*",
          });
          const validationError = options.validate?.(value);
          if (!validationError) {
            return value;
          }
          printBlock("[warn]", validationError, pc.yellow);
        } catch (error: unknown) {
          wrapCancellation(error);
        }
      }
    },

    spinner() {
      return createSpinner();
    },
  };
}

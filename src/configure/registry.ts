import { modelSection } from "./sections/model";
import { providerSection } from "./sections/provider";
import { secretsSection } from "./sections/secrets";
import type { ConfigureSection } from "./types";

export class SectionRegistry {
  readonly #sections = new Map<string, ConfigureSection>();

  register(section: ConfigureSection): void {
    if (this.#sections.has(section.name)) {
      throw new Error(`Section already registered: ${section.name}`);
    }

    this.#sections.set(section.name, section);
  }

  get(name: string): ConfigureSection | undefined {
    return this.#sections.get(name);
  }

  list(): ConfigureSection[] {
    return [...this.#sections.values()].toSorted((left, right) => left.order - right.order);
  }

  names(): string[] {
    return this.list().map((section) => section.name);
  }
}

export function registerAllSections(): SectionRegistry {
  const registry = new SectionRegistry();
  registry.register(providerSection);
  registry.register(modelSection);
  registry.register(secretsSection);
  return registry;
}

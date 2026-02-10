import type { CapabilityProfile } from "./profile.ts";

export class CapabilityRegistry {
  private readonly profiles = new Map<string, CapabilityProfile>();

  register(profile: CapabilityProfile): void {
    this.profiles.set(profile.id, profile);
  }

  get(id: string): CapabilityProfile | undefined {
    return this.profiles.get(id);
  }

  has(id: string): boolean {
    return this.profiles.has(id);
  }

  list(): CapabilityProfile[] {
    return Array.from(this.profiles.values());
  }
}

import { z } from "zod";

export const SandboxVibeboxSchema = z
  .object({
    enabled: z.boolean().optional(),
    binPath: z.string().optional(),
    projectRoot: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    provider: z.enum(["off", "apple-vm", "docker", "auto"]).optional(),
  })
  .strict();

export const SandboxDockerSchema = z
  .object({
    image: z.string().optional(),
    workdir: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    network: z.string().optional(),
    mounts: z.array(z.string()).optional(),
  })
  .strict();

export const SandboxAppleSchema = z
  .object({
    image: z.string().optional(),
    workdir: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    network: z.string().optional(),
    mounts: z.array(z.string()).optional(),
    backend: z.enum(["native", "vibebox"]).optional(),
    vibebox: SandboxVibeboxSchema.optional(),
  })
  .strict();

export const SandboxSchema = z
  .object({
    mode: z.enum(["off", "apple-vm", "docker"]).optional(),
    autoBootstrapOnStart: z.boolean().optional(),
    workspaceAccess: z.enum(["none", "ro", "rw"]).optional(),
    docker: SandboxDockerSchema.optional(),
    apple: SandboxAppleSchema.optional(),
  })
  .strict();

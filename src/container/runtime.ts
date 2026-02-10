import { execa, type ExecaError } from "execa";
import { logger } from "../logger";

export type ContainerBackend = "docker" | "apple";

export interface ContainerConfig {
  backend: ContainerBackend;
  image: string;
  workdir?: string;
  env?: Record<string, string>;
  mounts?: Mount[];
  network?: string;
  memoryMb?: number;
  cpus?: number;
}

export interface Mount {
  source: string;
  target: string;
  readonly?: boolean;
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: "created" | "running" | "exited" | "error";
  backend: ContainerBackend;
}

export class ContainerRuntime {
  private backend: ContainerBackend;

  constructor(backend: ContainerBackend = "docker") {
    this.backend = backend;
  }

  // Check if runtime is available
  async isAvailable(): Promise<boolean> {
    try {
      if (this.backend === "docker") {
        await execa("docker", ["info"], { reject: true });
      } else {
        await execa("container", ["info"], { reject: true });
      }
      return true;
    } catch {
      return false;
    }
  }

  // Create and start a container
  async create(name: string, config: ContainerConfig): Promise<ContainerInfo> {
    const args = this.buildArgs(config);
    const cmd = this.backend === "docker" ? "docker" : "container";

    logger.info({ name, image: config.image, backend: this.backend }, "Creating container");

    try {
      const result = await execa(cmd, ["run", "-d", "--name", name, ...args, config.image]);
      const id = result.stdout.trim();

      const info: ContainerInfo = {
        id,
        name,
        status: "running",
        backend: this.backend,
      };

      return info;
    } catch (err) {
      logger.error({ err, name }, "Failed to create container");
      throw err;
    }
  }

  // Execute command in running container
  async exec(
    name: string,
    command: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cmd = this.backend === "docker" ? "docker" : "container";

    logger.debug({ name, command }, "Executing command in container");

    try {
      const result = await execa(cmd, ["exec", name, ...command], { reject: false });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 0,
      };
    } catch (err) {
      const execaErr = err as ExecaError;
      return {
        stdout: (execaErr.stdout as string) ?? "",
        stderr: (execaErr.stderr as string) ?? "",
        exitCode: execaErr.exitCode ?? 1,
      };
    }
  }

  // Stop container
  async stop(name: string, timeoutSec: number = 10): Promise<void> {
    logger.info({ name }, "Stopping container");

    if (this.backend === "docker") {
      await execa("docker", ["stop", "-t", String(timeoutSec), name]);
    } else {
      await execa("container", ["stop", name]);
    }
  }

  // Remove container
  async remove(name: string, force: boolean = false): Promise<void> {
    logger.info({ name, force }, "Removing container");

    const cmd = this.backend === "docker" ? "docker" : "container";
    const args = ["rm"];

    if (force) {
      args.push(this.backend === "docker" ? "-f" : "--force");
    }
    args.push(name);

    await execa(cmd, args);
  }

  // Get container status
  async inspect(name: string): Promise<ContainerInfo | undefined> {
    try {
      if (this.backend === "docker") {
        const result = await execa("docker", [
          "inspect",
          name,
          "--format",
          "{{.Id}} {{.State.Status}}",
        ]);
        const [id, statusText] = result.stdout.trim().split(" ");

        let status: ContainerInfo["status"] = "error";
        if (statusText === "running") {
          status = "running";
        } else if (statusText === "created") {
          status = "created";
        } else if (statusText === "exited") {
          status = "exited";
        }

        return { id, name, status, backend: "docker" };
      } else {
        const result = await execa("container", ["inspect", name]);
        const parsed = JSON.parse(result.stdout);
        return {
          id: parsed.id,
          name: parsed.name,
          status: parsed.status,
          backend: "apple",
        };
      }
    } catch {
      return undefined;
    }
  }

  // List containers
  async list(prefix?: string): Promise<ContainerInfo[]> {
    const containers: ContainerInfo[] = [];

    try {
      if (this.backend === "docker") {
        const format = "{{.ID}}\t{{.Names}}\t{{.State}}";
        const result = await execa("docker", ["ps", "-a", "--format", format]);
        const lines = result.stdout.trim().split("\n");

        for (const line of lines) {
          if (!line) {
            continue;
          }
          const [id, name, statusText] = line.split("\t");
          if (prefix && !name.startsWith(prefix)) {
            continue;
          }

          let status: ContainerInfo["status"] = "error";
          if (statusText === "running") {
            status = "running";
          } else if (statusText === "created") {
            status = "created";
          } else if (statusText === "exited") {
            status = "exited";
          }

          containers.push({ id, name, status, backend: "docker" });
        }
      } else {
        const result = await execa("container", ["list", "--json"]);
        const parsed = JSON.parse(result.stdout);
        for (const item of parsed) {
          if (prefix && !item.name.startsWith(prefix)) {
            continue;
          }
          containers.push({
            id: item.id,
            name: item.name,
            status: item.status,
            backend: "apple",
          });
        }
      }
    } catch (err) {
      logger.error({ err }, "Failed to list containers");
    }

    return containers;
  }

  // Build command args from config
  private buildArgs(config: ContainerConfig): string[] {
    const args: string[] = [];

    if (config.workdir) {
      args.push("-w", config.workdir);
    }

    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    if (config.mounts) {
      for (const mount of config.mounts) {
        const ro = mount.readonly ? ":ro" : "";
        args.push("-v", `${mount.source}:${mount.target}${ro}`);
      }
    }

    if (config.network) {
      args.push("--network", config.network);
    }

    if (this.backend === "docker") {
      if (config.memoryMb) {
        args.push("-m", `${config.memoryMb}m`);
      }
      if (config.cpus) {
        args.push("--cpus", config.cpus.toString());
      }
    } else {
      // Apple Container resource limits (assuming similar flags if they exist)
      if (config.memoryMb) {
        args.push("--memory", `${config.memoryMb}m`);
      }
      if (config.cpus) {
        args.push("--cpus", config.cpus.toString());
      }
    }

    return args;
  }
}

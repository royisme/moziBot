import path from "node:path";
import { resolveConfigPath } from "../../config";

export type RuntimePaths = {
  configPath: string;
  baseDir: string;
  dataDir: string;
  logsDir: string;
  pidFile: string;
  logFile: string;
};

export function resolveRuntimePaths(configPath?: string): RuntimePaths {
  const resolvedConfig = configPath ? path.resolve(configPath) : resolveConfigPath();
  const baseDir = path.dirname(resolvedConfig);
  const dataDir = path.join(baseDir, "data");
  const logsDir = path.join(baseDir, "logs");
  return {
    configPath: resolvedConfig,
    baseDir,
    dataDir,
    logsDir,
    pidFile: path.join(dataDir, "mozi.pid"),
    logFile: path.join(logsDir, "runtime.log"),
  };
}

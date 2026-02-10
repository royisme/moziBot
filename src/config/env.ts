const ENV_PATTERN = /\$\{([^}]+)\}/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function replaceEnvVars(
  config: unknown,
  env: Record<string, string | undefined> = process.env,
): unknown {
  if (typeof config === "string") {
    return config.replace(ENV_PATTERN, (_match, key) => {
      const value = env[key];
      if (value === undefined) {
        return _match;
      }
      return value;
    });
  }

  if (Array.isArray(config)) {
    return config.map((item) => replaceEnvVars(item, env));
  }

  if (isPlainObject(config)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      result[key] = replaceEnvVars(value, env);
    }
    return result;
  }

  return config;
}

/** The key an environment really uses for `name`: Windows copies keep `Path`, not `PATH`. */
export function envKey(env: NodeJS.ProcessEnv, name: string): string {
  return Object.keys(env).find((key) => key.toUpperCase() === name) ?? name;
}

export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[envKey(env, name)];
}

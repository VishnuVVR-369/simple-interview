const DEFAULT_PORT = 8787;

export interface AppConfig {
  port: number;
  openAiApiKey: string;
  appPassword: string;
  r2AccountId: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2Bucket: string;
  allowedOrigins: string[];
  cookieSecure: boolean;
}

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_PORT;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid PORT value: ${value}`);
  }

  return parsed;
}

function parseOrigins(): string[] {
  const origins = new Set(["http://localhost:3000", "http://127.0.0.1:3000"]);

  for (const key of ["APP_ORIGIN", "WEB_ORIGIN", "NEXT_PUBLIC_API_ORIGIN"]) {
    const value = process.env[key];

    if (value) {
      origins.add(value.replace(/\/$/, ""));
    }
  }

  return [...origins];
}

export function loadConfig(): AppConfig {
  return {
    port: parsePort(process.env.PORT),
    openAiApiKey: requiredEnv("OPENAI_API_KEY"),
    appPassword: requiredEnv("APP_PASSWORD"),
    r2AccountId: requiredEnv("R2_ACCOUNT_ID"),
    r2AccessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
    r2SecretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    r2Bucket: requiredEnv("R2_BUCKET"),
    allowedOrigins: parseOrigins(),
    cookieSecure: process.env.COOKIE_SECURE === "true",
  };
}

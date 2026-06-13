import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./env";

const COOKIE_NAME = "simple_interview_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sessions = new Map<string, number>();

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function isPasswordValid(value: string, config: AppConfig): boolean {
  const submitted = hash(value);
  const expected = hash(config.appPassword);

  return timingSafeEqual(submitted, expected);
}

export function createSessionToken(): string {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function revokeSessionToken(token: string | undefined): void {
  if (token) {
    sessions.delete(token);
  }
}

export function isAuthenticated(request: Request): boolean {
  const token = getCookie(request, COOKIE_NAME);

  if (!token) {
    return false;
  }

  const expiresAt = sessions.get(token);

  if (!expiresAt) {
    return false;
  }

  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }

  return true;
}

export function getSessionToken(request: Request): string | undefined {
  return getCookie(request, COOKIE_NAME);
}

export function sessionCookie(token: string, config: AppConfig): string {
  return [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    config.cookieSecure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie(config: AppConfig): string {
  return [
    `${COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
    config.cookieSecure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");

  if (!header) {
    return undefined;
  }

  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    const key = rawKey?.trim();

    if (key === name) {
      return rawValue.join("=");
    }
  }

  return undefined;
}

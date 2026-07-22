import type { Env } from "./types";
import { AppError } from "./errors";

export function envBool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function requireSecrets(env: Env): void {
  const missing = [
    ["ACTION_API_KEY", env.ACTION_API_KEY],
    ["GITHUB_APP_ID", env.GITHUB_APP_ID],
    ["GITHUB_PRIVATE_KEY_BASE64", env.GITHUB_PRIVATE_KEY_BASE64],
    ["ALLOWED_REPOSITORIES", env.ALLOWED_REPOSITORIES]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new AppError(`Missing required configuration: ${missing.join(", ")}`, 500, "configuration_error");
  }
}

export function branchPrefix(env: Env): string {
  return env.BRANCH_PREFIX?.trim() || "chatgpt/";
}

export function planLimits(env: Env) {
  return {
    ttlMinutes: envInt(env.PLAN_TTL_MINUTES, 30, 5, 1440),
    maxFiles: envInt(env.MAX_PLAN_FILES, 12, 1, 40),
    maxBytes: envInt(env.MAX_PLAN_BYTES, 512 * 1024, 1024, 2 * 1024 * 1024),
    maxDiffBytes: envInt(env.MAX_DIFF_BYTES, 192 * 1024, 4096, 1024 * 1024)
  };
}

export function allowedWorkflows(env: Env): Set<string> {
  return new Set(
    (env.ALLOWED_WORKFLOWS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

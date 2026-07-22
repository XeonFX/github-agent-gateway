import type { Env } from "./types";
import { AppError } from "./errors";

export type BranchWritePolicy = "prefixed" | "unrestricted";

const DEFAULT_WRITABLE_BRANCH_PREFIX = "agent/";
const DEFAULT_PROTECTED_BRANCHES = "main,master";

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
    ["GITHUB_PRIVATE_KEY_BASE64", env.GITHUB_PRIVATE_KEY_BASE64]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new AppError(`Missing required configuration: ${missing.join(", ")}`, 500, "configuration_error");
  }
}

function csvValues(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function assertValidBranchPrefix(prefix: string): void {
  if (
    !prefix ||
    prefix.length > 200 ||
    prefix.startsWith("-") ||
    prefix.endsWith(".") ||
    prefix.includes("..") ||
    prefix.includes("@{") ||
    prefix.includes("\\") ||
    /\s|[~^:?*\[]/.test(prefix) ||
    prefix.includes("//") ||
    prefix.includes("/.")
  ) {
    throw new AppError(`Invalid writable branch prefix: ${prefix}`, 500, "configuration_error");
  }
}

export function branchWritePolicy(env: Env): BranchWritePolicy {
  const policy = (env.BRANCH_WRITE_POLICY?.trim().toLowerCase() || "prefixed") as BranchWritePolicy;
  if (policy !== "prefixed" && policy !== "unrestricted") {
    throw new AppError(
      "BRANCH_WRITE_POLICY must be either prefixed or unrestricted",
      500,
      "configuration_error"
    );
  }
  return policy;
}

export function writableBranchPrefixes(env: Env): string[] {
  // BRANCH_PREFIX is retained as a backwards-compatible fallback for existing deployments.
  const raw = env.WRITABLE_BRANCH_PREFIXES?.trim() || env.BRANCH_PREFIX?.trim() || DEFAULT_WRITABLE_BRANCH_PREFIX;
  const prefixes = csvValues(raw);
  if (prefixes.length === 0) {
    throw new AppError("At least one writable branch prefix is required", 500, "configuration_error");
  }
  for (const prefix of prefixes) assertValidBranchPrefix(prefix);
  return prefixes;
}

export function generatedBranchPrefix(env: Env): string {
  return writableBranchPrefixes(env)[0] ?? DEFAULT_WRITABLE_BRANCH_PREFIX;
}

export function protectedBranches(env: Env): Set<string> {
  return new Set(
    csvValues(env.PROTECTED_BRANCHES?.trim() || DEFAULT_PROTECTED_BRANCHES)
      .map((branch) => branch.toLowerCase())
  );
}

/** @deprecated Use generatedBranchPrefix or writableBranchPrefixes. */
export function branchPrefix(env: Env): string {
  return generatedBranchPrefix(env);
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

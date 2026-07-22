import type { Env } from "./types";
import { AppError } from "./errors";
import { branchWritePolicy, envBool, protectedBranches, writableBranchPrefixes } from "./config";

export function assertSafeRef(ref: string): void {
  if (!ref || ref.length > 255) throw new AppError("Invalid ref");
  if (ref.startsWith("-") || ref.endsWith(".") || ref.includes("..") || ref.includes("@{") || ref.includes("\\")) {
    throw new AppError("Unsafe Git ref", 400, "unsafe_ref");
  }
  if (/\s|[~^:?*\[]/.test(ref) || ref.includes("//") || ref.endsWith("/") || ref.includes("/.")) {
    throw new AppError("Unsafe Git ref", 400, "unsafe_ref");
  }
}

export function assertNotProtectedBranch(env: Env, branch: string): void {
  if (protectedBranches(env).has(branch.toLowerCase())) {
    throw new AppError(`Branch ${branch} is protected by gateway policy`, 403, "protected_branch");
  }
}

export function assertNotDefaultBranch(branch: string, defaultBranch: string | null | undefined): void {
  if (defaultBranch && branch.toLowerCase() === defaultBranch.toLowerCase()) {
    throw new AppError(`Direct writes to the default branch ${defaultBranch} are not allowed`, 403, "default_branch");
  }
}

export function assertWritableBranch(env: Env, branch: string): void {
  assertSafeRef(branch);
  assertNotProtectedBranch(env, branch);

  if (branchWritePolicy(env) === "unrestricted") return;

  const prefixes = writableBranchPrefixes(env);
  if (!prefixes.some((prefix) => branch.startsWith(prefix))) {
    throw new AppError(
      `Writable branches must start with one of: ${prefixes.join(", ")}`,
      403,
      "branch_prefix_required"
    );
  }
}

/** @deprecated Use assertWritableBranch. */
export const assertAgentBranch = assertWritableBranch;

function validatePath(path: string): { normalized: string; lower: string; fileName: string } {
  const normalized = path.replace(/^\/+/, "");
  if (!normalized || normalized.length > 1024 || normalized.includes("\0")) {
    throw new AppError("Invalid repository path", 400, "unsafe_path");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    throw new AppError("Path traversal is not allowed", 400, "unsafe_path");
  }
  return {
    normalized,
    lower: normalized.toLowerCase(),
    fileName: segments.at(-1)?.toLowerCase() || ""
  };
}

export function assertReadablePath(path: string): void {
  const { normalized, fileName } = validatePath(path);
  const blocked =
    fileName === ".env" ||
    fileName.startsWith(".env.") ||
    fileName === "id_rsa" ||
    fileName === "id_ed25519" ||
    fileName.endsWith(".pem") ||
    fileName.endsWith(".p12") ||
    fileName.endsWith(".pfx") ||
    fileName.endsWith(".key");

  if (blocked) throw new AppError(`Credential-like file is blocked: ${normalized}`, 403, "sensitive_path");
}

export function assertSafePath(env: Env, path: string): void {
  assertReadablePath(path);
  const { lower } = validatePath(path);
  if (lower.startsWith(".github/workflows/") && !envBool(env.ENABLE_WORKFLOW_FILE_CHANGES)) {
    throw new AppError("Workflow file changes are disabled", 403, "workflow_file_changes_disabled");
  }
}

export function requireFeature(enabled: boolean, feature: string): void {
  if (!enabled) throw new AppError(`${feature} is disabled by configuration`, 403, "feature_disabled");
}

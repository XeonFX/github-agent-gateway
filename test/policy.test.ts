import { describe, expect, it } from "vitest";
import { assertAgentBranch, assertReadablePath, assertRepositoryAllowed, assertSafePath } from "../src/policy";
import type { Env } from "../src/types";

const env = {
  ALLOWED_REPOSITORIES: "XeonFX/Peerly,XeonFX/HeyHubs",
  BRANCH_PREFIX: "chatgpt/",
  ENABLE_WORKFLOW_FILE_CHANGES: "false"
} as Env;

describe("repository policy", () => {
  it("accepts an allowlisted repository case-insensitively", () => {
    expect(() => assertRepositoryAllowed(env, "xeonfx", "peerly")).not.toThrow();
  });

  it("rejects other repositories", () => {
    expect(() => assertRepositoryAllowed(env, "other", "repo")).toThrow(/not allowlisted/);
  });

  it("requires the configured branch prefix", () => {
    expect(() => assertAgentBranch(env, "chatgpt/fix-test")).not.toThrow();
    expect(() => assertAgentBranch(env, "main")).toThrow(/must start/);
  });

  it("blocks credential-like paths and workflow changes", () => {
    expect(() => assertSafePath(env, ".env")).toThrow(/blocked/);
    expect(() => assertSafePath(env, "certs/app.pem")).toThrow(/blocked/);
    expect(() => assertReadablePath(".github/workflows/release.yml")).not.toThrow();
    expect(() => assertSafePath(env, ".github/workflows/release.yml")).toThrow(/disabled/);
    expect(() => assertSafePath(env, "src/config.ts")).not.toThrow();
  });
});

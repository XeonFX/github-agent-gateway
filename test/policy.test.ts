import { describe, expect, it } from "vitest";
import {
  assertNotDefaultBranch,
  assertReadablePath,
  assertSafePath,
  assertWritableBranch
} from "../src/policy";
import type { Env } from "../src/types";

const baseEnv = {
  BRANCH_WRITE_POLICY: "prefixed",
  WRITABLE_BRANCH_PREFIXES: "agent/,automation/",
  PROTECTED_BRANCHES: "main,master,production",
  ENABLE_WORKFLOW_FILE_CHANGES: "false"
} as Env;

describe("repository policy", () => {
  it("supports multiple configured branch prefixes", () => {
    expect(() => assertWritableBranch(baseEnv, "agent/fix-test")).not.toThrow();
    expect(() => assertWritableBranch(baseEnv, "automation/dependency-update")).not.toThrow();
    expect(() => assertWritableBranch(baseEnv, "feature/unapproved-prefix")).toThrow(/must start/);
  });

  it("supports unrestricted non-protected branch names", () => {
    const env = { ...baseEnv, BRANCH_WRITE_POLICY: "unrestricted" } as Env;
    expect(() => assertWritableBranch(env, "feature/fix-test")).not.toThrow();
    expect(() => assertWritableBranch(env, "bugfix-123")).not.toThrow();
    expect(() => assertWritableBranch(env, "main")).toThrow(/protected/);
    expect(() => assertWritableBranch(env, "production")).toThrow(/protected/);
  });

  it("retains legacy BRANCH_PREFIX compatibility", () => {
    const env = {
      BRANCH_PREFIX: "legacy/",
      ENABLE_WORKFLOW_FILE_CHANGES: "false"
    } as Env;
    expect(() => assertWritableBranch(env, "legacy/fix-test")).not.toThrow();
    expect(() => assertWritableBranch(env, "agent/fix-test")).toThrow(/must start/);
  });

  it("always blocks direct default branch writes", () => {
    expect(() => assertNotDefaultBranch("trunk", "trunk")).toThrow(/default branch/);
    expect(() => assertNotDefaultBranch("feature/test", "trunk")).not.toThrow();
  });

  it("blocks credential-like paths and workflow changes", () => {
    expect(() => assertSafePath(baseEnv, ".env")).toThrow(/blocked/);
    expect(() => assertSafePath(baseEnv, "certs/app.pem")).toThrow(/blocked/);
    expect(() => assertReadablePath(".github/workflows/release.yml")).not.toThrow();
    expect(() => assertSafePath(baseEnv, ".github/workflows/release.yml")).toThrow(/disabled/);
    expect(() => assertSafePath(baseEnv, "src/config.ts")).not.toThrow();
  });
});

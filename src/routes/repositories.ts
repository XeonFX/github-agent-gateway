import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables, Env } from "../types";
import { allowedRepositories, assertNotDefaultBranch, assertReadablePath, assertWritableBranch, requireFeature } from "../policy";
import { GitHubClient } from "../github/client";
import { repoFromContext, audit } from "./common";
import { createBranchSchema, repositorySettingsSchema, confirmationSchema } from "../schemas";
import { assertExactConfirmation } from "../utils";
import { allowedWorkflows, branchWritePolicy, envBool, generatedBranchPrefix, planLimits, protectedBranches, writableBranchPrefixes } from "../config";
import { AppError, isNotFound } from "../errors";

export const repositoryRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

repositoryRoutes.get("/capabilities", (c) => {
  const limits = planLimits(c.env);
  return c.json({
    service: "github-agent-gateway",
    version: "1.1.0",
    repositories: allowedRepositories(c.env).map(({ owner, repository }) => `${owner}/${repository}`),
    branchPolicy: {
      mode: branchWritePolicy(c.env),
      writablePrefixes: writableBranchPrefixes(c.env),
      generatedPrefix: generatedBranchPrefix(c.env),
      protectedBranches: [...protectedBranches(c.env)],
      defaultBranchWritesAllowed: false
    },
    limits,
    workflows: {
      writeEnabled: envBool(c.env.ENABLE_WORKFLOW_WRITE),
      fileChangesEnabled: envBool(c.env.ENABLE_WORKFLOW_FILE_CHANGES),
      allowlist: [...allowedWorkflows(c.env)]
    },
    features: {
      merge: envBool(c.env.ENABLE_MERGE),
      destructiveOperations: envBool(c.env.ENABLE_DESTRUCTIVE_OPERATIONS),
      administration: envBool(c.env.ENABLE_ADMIN_OPERATIONS)
    }
  });
});

repositoryRoutes.get("/repositories", async (c) => {
  const client = new GitHubClient(c.env);
  const repositories = await Promise.all(allowedRepositories(c.env).map(async ({ owner, repository }) => {
    try {
      return await client.request<Record<string, unknown>>(
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
        { owner, repository }
      );
    } catch (error) {
      return { full_name: `${owner}/${repository}`, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return c.json({ repositories });
});

repositoryRoutes.get("/repos/:owner/:repository", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const result = await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
    { owner, repository }
  );
  return c.json(result);
});

repositoryRoutes.patch("/repos/:owner/:repository", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_ADMIN_OPERATIONS), "Repository administration");
  const input = repositorySettingsSchema.parse(await c.req.json());
  assertExactConfirmation(input.confirmation, `UPDATE ${owner}/${repository}`);
  if (input.settings.archived === true || input.settings.visibility || input.settings.private !== undefined) {
    requireFeature(envBool(c.env.ENABLE_DESTRUCTIVE_OPERATIONS), "Destructive operations");
  }
  const result = await new GitHubClient(c.env).request(
    "PATCH",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
    { owner, repository, body: input.settings }
  );
  await audit(c, "repository.update", { owner, repository, metadata: { keys: Object.keys(input.settings) } });
  return c.json(result);
});

repositoryRoutes.get("/repos/:owner/:repository/contents", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const path = c.req.query("path") || "";
  if (path) assertReadablePath(path);
  const ref = c.req.query("ref");
  const encodedPath = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  const result = await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents${encodedPath}`,
    { owner, repository, query: { ref } }
  );
  return c.json(result);
});

repositoryRoutes.get("/repos/:owner/:repository/tree", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const ref = c.req.query("ref") || "HEAD";
  const recursive = c.req.query("recursive") !== "false";
  const client = new GitHubClient(c.env);
  const commit = await client.request<{ commit: { tree: { sha: string } } }>(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(ref)}`,
    { owner, repository }
  );
  const result = await client.request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/trees/${commit.commit.tree.sha}`,
    { owner, repository, query: { recursive: recursive ? 1 : undefined } }
  );
  return c.json(result);
});

repositoryRoutes.get("/repos/:owner/:repository/branches", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const result = await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches`,
    { owner, repository, query: { per_page: Math.min(Number(c.req.query("perPage") || 50), 100), protected: c.req.query("protected") } }
  );
  return c.json(result);
});

repositoryRoutes.post("/repos/:owner/:repository/branches", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const input = createBranchSchema.parse(await c.req.json());
  assertWritableBranch(c.env, input.name);
  const client = new GitHubClient(c.env);
  const metadata = await client.request<{ default_branch: string | null }>(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
    { owner, repository }
  );
  assertNotDefaultBranch(input.name, metadata.default_branch);
  const source = await client.request<{ object: { sha: string } }>(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/ref/heads/${input.fromRef.split("/").map(encodeURIComponent).join("/")}`,
    { owner, repository }
  );
  const result = await client.request(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/refs`,
    { owner, repository, body: { ref: `refs/heads/${input.name}`, sha: source.object.sha } }
  );
  await audit(c, "branch.create", { owner, repository, target: input.name, metadata: { fromRef: input.fromRef } });
  return c.json(result, 201);
});

repositoryRoutes.delete("/repos/:owner/:repository/branches/:branch", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_DESTRUCTIVE_OPERATIONS), "Destructive operations");
  const branch = c.req.param("branch");
  assertWritableBranch(c.env, branch);
  const client = new GitHubClient(c.env);
  const metadata = await client.request<{ default_branch: string | null }>(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
    { owner, repository }
  );
  assertNotDefaultBranch(branch, metadata.default_branch);
  const input = confirmationSchema.parse(await c.req.json());
  assertExactConfirmation(input.confirmation, `DELETE BRANCH ${owner}/${repository} ${branch}`);
  await client.request(
    "DELETE",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
    { owner, repository }
  );
  await audit(c, "branch.delete", { owner, repository, target: branch });
  return c.body(null, 204);
});

repositoryRoutes.get("/repos/:owner/:repository/commits", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const result = await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits`,
    { owner, repository, query: { sha: c.req.query("sha"), path: c.req.query("path"), per_page: Math.min(Number(c.req.query("perPage") || 30), 100) } }
  );
  return c.json(result);
});

repositoryRoutes.get("/repos/:owner/:repository/commits/:ref", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const result = await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(c.req.param("ref"))}`,
    { owner, repository }
  );
  return c.json(result);
});

repositoryRoutes.get("/repos/:owner/:repository/compare", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const base = c.req.query("base");
  const head = c.req.query("head");
  if (!base || !head) throw new AppError("base and head query parameters are required");
  const result = await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    { owner, repository }
  );
  return c.json(result);
});

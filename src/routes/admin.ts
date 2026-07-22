import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { GitHubClient } from "../github/client";
import { repoFromContext, audit } from "./common";
import { branchProtectionSchema, collaboratorSchema, confirmationSchema } from "../schemas";
import { requireFeature } from "../policy";
import { envBool } from "../config";
import { assertExactConfirmation } from "../utils";

export const adminRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

adminRoutes.get("/repos/:owner/:repository/branches/:branch/protection", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_ADMIN_OPERATIONS), "Repository administration");
  const branch = c.req.param("branch");
  return c.json(await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches/${branch.split("/").map(encodeURIComponent).join("/")}/protection`,
    { owner, repository }
  ));
});

adminRoutes.put("/repos/:owner/:repository/branches/:branch/protection", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_ADMIN_OPERATIONS), "Repository administration");
  const branch = c.req.param("branch");
  const input = branchProtectionSchema.parse(await c.req.json());
  assertExactConfirmation(input.confirmation, `PROTECT ${owner}/${repository} ${branch}`);
  const result = await new GitHubClient(c.env).request(
    "PUT",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches/${branch.split("/").map(encodeURIComponent).join("/")}/protection`,
    { owner, repository, body: input.protection }
  );
  await audit(c, "branch_protection.update", { owner, repository, target: branch });
  return c.json(result);
});

adminRoutes.delete("/repos/:owner/:repository/branches/:branch/protection", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_ADMIN_OPERATIONS), "Repository administration");
  requireFeature(envBool(c.env.ENABLE_DESTRUCTIVE_OPERATIONS), "Destructive operations");
  const branch = c.req.param("branch");
  const input = confirmationSchema.parse(await c.req.json());
  assertExactConfirmation(input.confirmation, `UNPROTECT ${owner}/${repository} ${branch}`);
  await new GitHubClient(c.env).request(
    "DELETE",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches/${branch.split("/").map(encodeURIComponent).join("/")}/protection`,
    { owner, repository }
  );
  await audit(c, "branch_protection.delete", { owner, repository, target: branch });
  return c.body(null, 204);
});

adminRoutes.get("/repos/:owner/:repository/collaborators", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_ADMIN_OPERATIONS), "Repository administration");
  return c.json(await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/collaborators`,
    { owner, repository, query: { affiliation: c.req.query("affiliation") || "all", per_page: 100 } }
  ));
});

adminRoutes.put("/repos/:owner/:repository/collaborators/:username", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_ADMIN_OPERATIONS), "Repository administration");
  const username = c.req.param("username");
  const input = collaboratorSchema.parse(await c.req.json());
  assertExactConfirmation(input.confirmation, `INVITE ${username} TO ${owner}/${repository} AS ${input.permission}`);
  const result = await new GitHubClient(c.env).request(
    "PUT",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/collaborators/${encodeURIComponent(username)}`,
    { owner, repository, body: { permission: input.permission } }
  );
  await audit(c, "collaborator.add", { owner, repository, target: username, metadata: { permission: input.permission } });
  return c.json(result);
});

adminRoutes.delete("/repos/:owner/:repository/collaborators/:username", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_ADMIN_OPERATIONS), "Repository administration");
  requireFeature(envBool(c.env.ENABLE_DESTRUCTIVE_OPERATIONS), "Destructive operations");
  const username = c.req.param("username");
  const input = confirmationSchema.parse(await c.req.json());
  assertExactConfirmation(input.confirmation, `REMOVE ${username} FROM ${owner}/${repository}`);
  await new GitHubClient(c.env).request(
    "DELETE",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/collaborators/${encodeURIComponent(username)}`,
    { owner, repository }
  );
  await audit(c, "collaborator.remove", { owner, repository, target: username });
  return c.body(null, 204);
});

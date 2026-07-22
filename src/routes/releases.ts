import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { GitHubClient } from "../github/client";
import { repoFromContext, audit } from "./common";
import { createReleaseSchema, updateReleaseSchema, createTagSchema, releaseIdSchema, confirmationSchema } from "../schemas";
import { assertExactConfirmation } from "../utils";
import { requireFeature } from "../policy";
import { envBool } from "../config";

export const releaseRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

releaseRoutes.get("/repos/:owner/:repository/releases", async (c) => {
  const { owner, repository } = repoFromContext(c);
  return c.json(await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases`,
    { owner, repository, query: { per_page: Math.min(Number(c.req.query("perPage") || 30), 100) } }
  ));
});

releaseRoutes.get("/repos/:owner/:repository/releases/latest", async (c) => {
  const { owner, repository } = repoFromContext(c);
  return c.json(await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/latest`,
    { owner, repository }
  ));
});

releaseRoutes.post("/repos/:owner/:repository/releases", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const input = createReleaseSchema.parse(await c.req.json());
  const result = await new GitHubClient(c.env).request(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases`,
    { owner, repository, body: {
      tag_name: input.tagName,
      target_commitish: input.targetCommitish,
      name: input.name,
      body: input.body,
      draft: input.draft,
      prerelease: input.prerelease,
      generate_release_notes: input.generateReleaseNotes
    } }
  );
  await audit(c, "release.create", { owner, repository, target: input.tagName, metadata: { draft: input.draft, prerelease: input.prerelease } });
  return c.json(result, 201);
});

releaseRoutes.get("/repos/:owner/:repository/releases/:releaseId", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const releaseId = releaseIdSchema.parse(c.req.param("releaseId"));
  return c.json(await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/${releaseId}`,
    { owner, repository }
  ));
});

releaseRoutes.patch("/repos/:owner/:repository/releases/:releaseId", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const releaseId = releaseIdSchema.parse(c.req.param("releaseId"));
  const input = updateReleaseSchema.parse(await c.req.json());
  const result = await new GitHubClient(c.env).request(
    "PATCH",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/${releaseId}`,
    { owner, repository, body: {
      tag_name: input.tagName,
      target_commitish: input.targetCommitish,
      name: input.name,
      body: input.body,
      draft: input.draft,
      prerelease: input.prerelease,
      generate_release_notes: input.generateReleaseNotes
    } }
  );
  await audit(c, "release.update", { owner, repository, target: String(releaseId) });
  return c.json(result);
});

releaseRoutes.delete("/repos/:owner/:repository/releases/:releaseId", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_DESTRUCTIVE_OPERATIONS), "Destructive operations");
  const releaseId = releaseIdSchema.parse(c.req.param("releaseId"));
  const input = confirmationSchema.parse(await c.req.json());
  assertExactConfirmation(input.confirmation, `DELETE RELEASE ${owner}/${repository} ${releaseId}`);
  await new GitHubClient(c.env).request(
    "DELETE",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/${releaseId}`,
    { owner, repository }
  );
  await audit(c, "release.delete", { owner, repository, target: String(releaseId) });
  return c.body(null, 204);
});

releaseRoutes.get("/repos/:owner/:repository/tags", async (c) => {
  const { owner, repository } = repoFromContext(c);
  return c.json(await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tags`,
    { owner, repository, query: { per_page: Math.min(Number(c.req.query("perPage") || 100), 100) } }
  ));
});

releaseRoutes.post("/repos/:owner/:repository/tags", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const input = createTagSchema.parse(await c.req.json());
  const client = new GitHubClient(c.env);
  let objectSha = input.targetSha;
  if (input.annotated) {
    const tagObject = await client.request<{ sha: string }>(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/tags`,
      { owner, repository, body: {
        tag: input.tag,
        message: input.message || input.tag,
        object: input.targetSha,
        type: input.type,
        tagger: input.tagger
      } }
    );
    objectSha = tagObject.sha;
  }
  const result = await client.request(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/refs`,
    { owner, repository, body: { ref: `refs/tags/${input.tag}`, sha: objectSha } }
  );
  await audit(c, "tag.create", { owner, repository, target: input.tag, metadata: { annotated: input.annotated, targetSha: input.targetSha } });
  return c.json(result, 201);
});

releaseRoutes.delete("/repos/:owner/:repository/tags/:tag", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_DESTRUCTIVE_OPERATIONS), "Destructive operations");
  const tag = c.req.param("tag");
  const input = confirmationSchema.parse(await c.req.json());
  assertExactConfirmation(input.confirmation, `DELETE TAG ${owner}/${repository} ${tag}`);
  await new GitHubClient(c.env).request(
    "DELETE",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/refs/tags/${tag.split("/").map(encodeURIComponent).join("/")}`,
    { owner, repository }
  );
  await audit(c, "tag.delete", { owner, repository, target: tag });
  return c.body(null, 204);
});

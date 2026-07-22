import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { GitHubClient } from "../github/client";
import { repoFromContext, audit } from "./common";
import { createIssueSchema, updateIssueSchema, commentSchema, issueNumberSchema, createLabelSchema, updateLabelSchema, confirmationSchema } from "../schemas";
import { assertExactConfirmation } from "../utils";
import { envBool } from "../config";
import { requireFeature } from "../policy";

export const issueRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

issueRoutes.get("/repos/:owner/:repository/issues", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const result = await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues`,
    { owner, repository, query: {
      state: c.req.query("state") || "open",
      labels: c.req.query("labels"),
      assignee: c.req.query("assignee"),
      creator: c.req.query("creator"),
      mentioned: c.req.query("mentioned"),
      sort: c.req.query("sort") || "updated",
      direction: c.req.query("direction") || "desc",
      per_page: Math.min(Number(c.req.query("perPage") || 30), 100)
    } }
  );
  return c.json(result);
});

issueRoutes.post("/repos/:owner/:repository/issues", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const input = createIssueSchema.parse(await c.req.json());
  const result = await new GitHubClient(c.env).request(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues`,
    { owner, repository, body: input }
  );
  await audit(c, "issue.create", { owner, repository, metadata: { title: input.title } });
  return c.json(result, 201);
});

issueRoutes.get("/repos/:owner/:repository/issues/:number", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const number = issueNumberSchema.parse(c.req.param("number"));
  return c.json(await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${number}`,
    { owner, repository }
  ));
});

issueRoutes.patch("/repos/:owner/:repository/issues/:number", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const number = issueNumberSchema.parse(c.req.param("number"));
  const input = updateIssueSchema.parse(await c.req.json());
  const result = await new GitHubClient(c.env).request(
    "PATCH",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${number}`,
    { owner, repository, body: {
      title: input.title,
      body: input.body,
      state: input.state,
      state_reason: input.stateReason,
      assignees: input.assignees,
      labels: input.labels,
      milestone: input.milestone
    } }
  );
  await audit(c, "issue.update", { owner, repository, target: String(number), metadata: input });
  return c.json(result);
});

issueRoutes.post("/repos/:owner/:repository/issues/:number/comments", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const number = issueNumberSchema.parse(c.req.param("number"));
  const input = commentSchema.parse(await c.req.json());
  const result = await new GitHubClient(c.env).request(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${number}/comments`,
    { owner, repository, body: input }
  );
  await audit(c, "issue.comment", { owner, repository, target: String(number) });
  return c.json(result, 201);
});

issueRoutes.get("/repos/:owner/:repository/labels", async (c) => {
  const { owner, repository } = repoFromContext(c);
  return c.json(await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/labels`,
    { owner, repository, query: { per_page: Math.min(Number(c.req.query("perPage") || 100), 100) } }
  ));
});

issueRoutes.post("/repos/:owner/:repository/labels", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const input = createLabelSchema.parse(await c.req.json());
  const result = await new GitHubClient(c.env).request(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/labels`,
    { owner, repository, body: input }
  );
  await audit(c, "label.create", { owner, repository, target: input.name });
  return c.json(result, 201);
});

issueRoutes.patch("/repos/:owner/:repository/labels/:name", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const name = c.req.param("name");
  const input = updateLabelSchema.parse(await c.req.json());
  const result = await new GitHubClient(c.env).request(
    "PATCH",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/labels/${encodeURIComponent(name)}`,
    { owner, repository, body: { new_name: input.newName, color: input.color, description: input.description } }
  );
  await audit(c, "label.update", { owner, repository, target: name, metadata: input });
  return c.json(result);
});

issueRoutes.delete("/repos/:owner/:repository/labels/:name", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_DESTRUCTIVE_OPERATIONS), "Destructive operations");
  const name = c.req.param("name");
  const input = confirmationSchema.parse(await c.req.json());
  assertExactConfirmation(input.confirmation, `DELETE LABEL ${owner}/${repository} ${name}`);
  await new GitHubClient(c.env).request(
    "DELETE",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/labels/${encodeURIComponent(name)}`,
    { owner, repository }
  );
  await audit(c, "label.delete", { owner, repository, target: name });
  return c.body(null, 204);
});

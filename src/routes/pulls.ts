import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { GitHubClient } from "../github/client";
import { repoFromContext, audit } from "./common";
import { createPullSchema, updatePullSchema, mergePullSchema, commentSchema, reviewersSchema, createReviewSchema, issueNumberSchema } from "../schemas";
import { assertAgentBranch, requireFeature } from "../policy";
import { assertExactConfirmation } from "../utils";
import { envBool } from "../config";
import { linkPlanPullRequest } from "../db";

export const pullRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

pullRoutes.get("/repos/:owner/:repository/pulls", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const result = await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls`,
    { owner, repository, query: {
      state: c.req.query("state") || "open",
      head: c.req.query("head"),
      base: c.req.query("base"),
      sort: c.req.query("sort") || "updated",
      direction: c.req.query("direction") || "desc",
      per_page: Math.min(Number(c.req.query("perPage") || 30), 100)
    } }
  );
  return c.json(result);
});

pullRoutes.post("/repos/:owner/:repository/pulls", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const input = createPullSchema.parse(await c.req.json());
  assertAgentBranch(c.env, input.head.includes(":") ? input.head.split(":").at(-1)! : input.head);
  const result = await new GitHubClient(c.env).request<{ number: number } & Record<string, unknown>>(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls`,
    {
      owner, repository,
      body: {
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        draft: input.draft,
        maintainer_can_modify: input.maintainerCanModify
      }
    }
  );
  if (input.changePlanId) await linkPlanPullRequest(c.env, input.changePlanId, result.number);
  await audit(c, "pull_request.create", { owner, repository, target: String(result.number), metadata: { head: input.head, base: input.base, draft: input.draft } });
  return c.json(result, 201);
});

pullRoutes.get("/repos/:owner/:repository/pulls/:number", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const number = issueNumberSchema.parse(c.req.param("number"));
  return c.json(await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${number}`,
    { owner, repository }
  ));
});

pullRoutes.patch("/repos/:owner/:repository/pulls/:number", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const number = issueNumberSchema.parse(c.req.param("number"));
  const input = updatePullSchema.parse(await c.req.json());
  const result = await new GitHubClient(c.env).request(
    "PATCH",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${number}`,
    { owner, repository, body: {
      title: input.title,
      body: input.body,
      state: input.state,
      base: input.base,
      maintainer_can_modify: input.maintainerCanModify
    } }
  );
  await audit(c, "pull_request.update", { owner, repository, target: String(number), metadata: input });
  return c.json(result);
});

pullRoutes.post("/repos/:owner/:repository/pulls/:number/comments", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const number = issueNumberSchema.parse(c.req.param("number"));
  const input = commentSchema.parse(await c.req.json());
  const result = await new GitHubClient(c.env).request(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${number}/comments`,
    { owner, repository, body: input }
  );
  await audit(c, "pull_request.comment", { owner, repository, target: String(number) });
  return c.json(result, 201);
});

pullRoutes.post("/repos/:owner/:repository/pulls/:number/reviewers", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const number = issueNumberSchema.parse(c.req.param("number"));
  const input = reviewersSchema.parse(await c.req.json());
  const result = await new GitHubClient(c.env).request(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${number}/requested_reviewers`,
    { owner, repository, body: { reviewers: input.reviewers, team_reviewers: input.teamReviewers } }
  );
  await audit(c, "pull_request.request_reviewers", { owner, repository, target: String(number), metadata: input });
  return c.json(result);
});

pullRoutes.delete("/repos/:owner/:repository/pulls/:number/reviewers", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const number = issueNumberSchema.parse(c.req.param("number"));
  const input = reviewersSchema.parse(await c.req.json());
  const result = await new GitHubClient(c.env).request(
    "DELETE",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${number}/requested_reviewers`,
    { owner, repository, body: { reviewers: input.reviewers, team_reviewers: input.teamReviewers } }
  );
  await audit(c, "pull_request.remove_reviewers", { owner, repository, target: String(number), metadata: input });
  return c.json(result);
});

pullRoutes.post("/repos/:owner/:repository/pulls/:number/reviews", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const number = issueNumberSchema.parse(c.req.param("number"));
  const input = createReviewSchema.parse(await c.req.json());
  const result = await new GitHubClient(c.env).request(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${number}/reviews`,
    { owner, repository, body: {
      body: input.body,
      event: input.event,
      commit_id: input.commitId,
      comments: input.comments
    } }
  );
  await audit(c, "pull_request.review", { owner, repository, target: String(number), metadata: { event: input.event } });
  return c.json(result, 201);
});

pullRoutes.put("/repos/:owner/:repository/pulls/:number/merge", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_MERGE), "Pull request merging");
  const number = issueNumberSchema.parse(c.req.param("number"));
  const input = mergePullSchema.parse(await c.req.json());
  assertExactConfirmation(input.confirmation, `MERGE ${owner}/${repository}#${number}`);
  const result = await new GitHubClient(c.env).request(
    "PUT",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${number}/merge`,
    { owner, repository, body: {
      commit_title: input.commitTitle,
      commit_message: input.commitMessage,
      merge_method: input.mergeMethod,
      sha: input.expectedHeadSha
    } }
  );
  await audit(c, "pull_request.merge", { owner, repository, target: String(number), metadata: { method: input.mergeMethod } });
  return c.json(result);
});

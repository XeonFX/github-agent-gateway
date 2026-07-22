import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { GitHubClient } from "../github/client";
import { repoFromContext, audit } from "./common";
import { dispatchWorkflowSchema, runIdSchema, confirmationSchema } from "../schemas";
import { allowedWorkflows, envBool } from "../config";
import { requireFeature } from "../policy";
import { AppError } from "../errors";
import { assertExactConfirmation } from "../utils";

export const actionRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function assertWorkflowAllowed(env: Env, workflow: string): void {
  const allowed = allowedWorkflows(env);
  if (allowed.size === 0 || !allowed.has(workflow)) {
    throw new AppError(`Workflow ${workflow} is not allowlisted`, 403, "workflow_not_allowed", { allowed: [...allowed] });
  }
}

actionRoutes.get("/repos/:owner/:repository/actions/workflows", async (c) => {
  const { owner, repository } = repoFromContext(c);
  return c.json(await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/workflows`,
    { owner, repository, query: { per_page: 100 } }
  ));
});

actionRoutes.post("/repos/:owner/:repository/actions/workflows/:workflow/dispatch", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_WORKFLOW_WRITE), "Workflow dispatch");
  const workflow = c.req.param("workflow");
  assertWorkflowAllowed(c.env, workflow);
  const input = dispatchWorkflowSchema.parse(await c.req.json());
  await new GitHubClient(c.env).request(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    { owner, repository, body: { ref: input.ref, inputs: input.inputs } }
  );
  await audit(c, "workflow.dispatch", { owner, repository, target: workflow, metadata: { ref: input.ref, inputKeys: Object.keys(input.inputs) } });
  return c.json({ dispatched: true, workflow, ref: input.ref }, 202);
});

actionRoutes.get("/repos/:owner/:repository/actions/runs", async (c) => {
  const { owner, repository } = repoFromContext(c);
  return c.json(await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs`,
    { owner, repository, query: {
      branch: c.req.query("branch"),
      event: c.req.query("event"),
      status: c.req.query("status"),
      per_page: Math.min(Number(c.req.query("perPage") || 30), 100)
    } }
  ));
});

actionRoutes.get("/repos/:owner/:repository/actions/runs/:runId", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const runId = runIdSchema.parse(c.req.param("runId"));
  return c.json(await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs/${runId}`,
    { owner, repository }
  ));
});

actionRoutes.get("/repos/:owner/:repository/actions/runs/:runId/jobs", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const runId = runIdSchema.parse(c.req.param("runId"));
  return c.json(await new GitHubClient(c.env).request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs/${runId}/jobs`,
    { owner, repository, query: { per_page: 100 } }
  ));
});

actionRoutes.get("/repos/:owner/:repository/actions/runs/:runId/logs-url", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const runId = runIdSchema.parse(c.req.param("runId"));
  const response = await new GitHubClient(c.env).requestResponse(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs/${runId}/logs`,
    { owner, repository, redirect: "manual" }
  );
  if (![302, 301].includes(response.status)) {
    const text = await response.text();
    throw new AppError(`Could not obtain workflow logs URL: ${response.status} ${text}`, response.status);
  }
  return c.json({ url: response.headers.get("location"), expiresSoon: true });
});

actionRoutes.post("/repos/:owner/:repository/actions/runs/:runId/rerun", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_WORKFLOW_WRITE), "Workflow write operations");
  const runId = runIdSchema.parse(c.req.param("runId"));
  const input = confirmationSchema.parse(await c.req.json());
  assertExactConfirmation(input.confirmation, `RERUN ${owner}/${repository} ${runId}`);
  await new GitHubClient(c.env).request(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs/${runId}/rerun`,
    { owner, repository }
  );
  await audit(c, "workflow.rerun", { owner, repository, target: String(runId) });
  return c.json({ rerun: true }, 202);
});

actionRoutes.post("/repos/:owner/:repository/actions/runs/:runId/cancel", async (c) => {
  const { owner, repository } = repoFromContext(c);
  requireFeature(envBool(c.env.ENABLE_WORKFLOW_WRITE), "Workflow write operations");
  const runId = runIdSchema.parse(c.req.param("runId"));
  const input = confirmationSchema.parse(await c.req.json());
  assertExactConfirmation(input.confirmation, `CANCEL ${owner}/${repository} ${runId}`);
  await new GitHubClient(c.env).request(
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs/${runId}/cancel`,
    { owner, repository }
  );
  await audit(c, "workflow.cancel", { owner, repository, target: String(runId) });
  return c.json({ cancelled: true }, 202);
});

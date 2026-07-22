import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { createChangePlanSchema, applyChangePlanSchema, createChangePlan, applyChangePlan } from "../change-plans";
import { getChangePlan, getIdempotentResponse, saveIdempotentResponse } from "../db";
import { assertExactConfirmation, getIdempotencyKey } from "../utils";
import { audit } from "./common";

export const changePlanRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

changePlanRoutes.post("/change-plans", async (c) => {
  const input = createChangePlanSchema.parse(await c.req.json());
  const plan = await createChangePlan(c.env, input);
  await audit(c, "change_plan.create", {
    owner: plan.owner,
    repository: plan.repository,
    target: plan.id,
    metadata: { branch: plan.proposedBranch, files: plan.changes.length }
  });
  return c.json(plan, 201);
});

changePlanRoutes.get("/change-plans/:id", async (c) => {
  return c.json(await getChangePlan(c.env, c.req.param("id")));
});

changePlanRoutes.post("/change-plans/:id/apply", async (c) => {
  const plan = await getChangePlan(c.env, c.req.param("id"));
  const input = applyChangePlanSchema.parse(await c.req.json());
  assertExactConfirmation(input.confirmation, `APPLY ${plan.owner}/${plan.repository} ${plan.proposedBranch}`);

  const key = getIdempotencyKey(c.req.raw.headers);
  const operation = `change_plan.apply:${plan.id}`;
  if (key) {
    const existing = await getIdempotentResponse(c.env, key, operation);
    if (existing !== undefined) return c.json(existing);
  }

  const result = await applyChangePlan(c.env, plan.id, input.expectedBaseSha);
  if (key) await saveIdempotentResponse(c.env, key, operation, result);
  await audit(c, "change_plan.apply", {
    owner: plan.owner,
    repository: plan.repository,
    target: plan.id,
    metadata: result
  });
  return c.json(result);
});

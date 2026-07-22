import type { Context } from "hono";
import type { AppVariables, Env } from "../types";
import { assertRepositoryAllowed } from "../policy";
import { writeAudit } from "../db";

export type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

export function repoFromContext(c: AppContext): { owner: string; repository: string } {
  const owner = c.req.param("owner");
  const repository = c.req.param("repository");
  assertRepositoryAllowed(c.env, owner, repository);
  return { owner, repository };
}

export async function audit(c: AppContext, operation: string, data: {
  owner?: string;
  repository?: string;
  target?: string;
  success?: boolean;
  metadata?: unknown;
} = {}): Promise<void> {
  await writeAudit(c.env, {
    requestId: c.get("requestId"),
    actor: c.get("actor"),
    operation,
    success: data.success ?? true,
    ...data
  });
}

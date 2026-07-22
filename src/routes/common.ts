import type { Context } from "hono";
import type { AppVariables, Env } from "../types";
import { writeAudit } from "../db";
import { AppError } from "../errors";

export type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

export function repoFromContext(c: AppContext): { owner: string; repository: string } {
  const owner = c.req.param("owner");
  const repository = c.req.param("repository");
  if (!owner || !repository) {
    throw new AppError("Repository route parameters are missing", 400, "missing_repository_parameters");
  }
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

import type { Env } from "./types";
import { AppError } from "./errors";
import { nowIso, safeJsonParse } from "./utils";

export interface StoredChangePlan {
  id: string;
  owner: string;
  repository: string;
  baseBranch: string;
  baseSha: string;
  proposedBranch: string;
  commitMessage: string;
  changes: unknown[];
  summary: Record<string, unknown>;
  diff: string;
  status: "pending" | "applied" | "expired" | "failed";
  createdAt: string;
  expiresAt: string;
  appliedAt?: string;
  commitSha?: string;
  pullRequestNumber?: number;
  failureReason?: string;
}

interface ChangePlanRow {
  id: string;
  owner: string;
  repository: string;
  base_branch: string;
  base_sha: string;
  proposed_branch: string;
  commit_message: string;
  changes_json: string;
  summary_json: string;
  diff_text: string;
  status: StoredChangePlan["status"];
  created_at: string;
  expires_at: string;
  applied_at: string | null;
  commit_sha: string | null;
  pull_request_number: number | null;
  failure_reason: string | null;
}

function mapPlan(row: ChangePlanRow): StoredChangePlan {
  return {
    id: row.id,
    owner: row.owner,
    repository: row.repository,
    baseBranch: row.base_branch,
    baseSha: row.base_sha,
    proposedBranch: row.proposed_branch,
    commitMessage: row.commit_message,
    changes: safeJsonParse(row.changes_json, []),
    summary: safeJsonParse(row.summary_json, {}),
    diff: row.diff_text,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.applied_at ? { appliedAt: row.applied_at } : {}),
    ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
    ...(row.pull_request_number !== null ? { pullRequestNumber: row.pull_request_number } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {})
  };
}

export async function insertChangePlan(env: Env, plan: StoredChangePlan): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO change_plans (
      id, owner, repository, base_branch, base_sha, proposed_branch,
      commit_message, changes_json, summary_json, diff_text, status,
      created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    plan.id, plan.owner, plan.repository, plan.baseBranch, plan.baseSha,
    plan.proposedBranch, plan.commitMessage, JSON.stringify(plan.changes),
    JSON.stringify(plan.summary), plan.diff, plan.status, plan.createdAt, plan.expiresAt
  ).run();
}

export async function getChangePlan(env: Env, id: string): Promise<StoredChangePlan> {
  const row = await env.DB.prepare("SELECT * FROM change_plans WHERE id = ?").bind(id).first<ChangePlanRow>();
  if (!row) throw new AppError("Change plan not found", 404, "change_plan_not_found");
  const plan = mapPlan(row);
  if (plan.status === "pending" && new Date(plan.expiresAt).getTime() <= Date.now()) {
    await env.DB.prepare("UPDATE change_plans SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(id).run();
    return { ...plan, status: "expired" };
  }
  return plan;
}

export async function markPlanApplied(env: Env, id: string, commitSha: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE change_plans
    SET status = 'applied', applied_at = ?, commit_sha = ?
    WHERE id = ? AND status = 'pending'
  `).bind(nowIso(), commitSha, id).run();
}

export async function markPlanFailed(env: Env, id: string, reason: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE change_plans SET status = 'failed', failure_reason = ?
    WHERE id = ? AND status = 'pending'
  `).bind(reason.slice(0, 2000), id).run();
}

export async function linkPlanPullRequest(env: Env, id: string, number: number): Promise<void> {
  await env.DB.prepare("UPDATE change_plans SET pull_request_number = ? WHERE id = ?").bind(number, id).run();
}

export async function writeAudit(
  env: Env,
  input: {
    requestId: string;
    actor?: string;
    operation: string;
    owner?: string;
    repository?: string;
    target?: string;
    success: boolean;
    metadata?: unknown;
  }
): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO audit_log (
        id, request_id, occurred_at, actor, operation, owner,
        repository, target, success, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), input.requestId, nowIso(), input.actor ?? "chatgpt-action",
      input.operation, input.owner ?? null, input.repository ?? null,
      input.target ?? null, input.success ? 1 : 0, JSON.stringify(input.metadata ?? {})
    ).run();
  } catch (error) {
    console.error("Failed to write audit log", error);
  }
}

export async function getIdempotentResponse(env: Env, key: string, operation: string): Promise<unknown | undefined> {
  const row = await env.DB.prepare(
    "SELECT response_json, expires_at FROM idempotency_keys WHERE key = ? AND operation = ?"
  ).bind(key, operation).first<{ response_json: string; expires_at: string }>();
  if (!row) return undefined;
  if (new Date(row.expires_at).getTime() <= Date.now()) return undefined;
  return safeJsonParse(row.response_json, undefined);
}

export async function saveIdempotentResponse(env: Env, key: string, operation: string, response: unknown): Promise<void> {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  await env.DB.prepare(`
    INSERT INTO idempotency_keys (key, operation, response_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      operation = excluded.operation,
      response_json = excluded.response_json,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `).bind(key, operation, JSON.stringify(response), nowIso(), expiresAt).run();
}

import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import type { Env } from "./types";
import { GitHubClient } from "./github/client";
import { AppError, isNotFound } from "./errors";
import { assertNotDefaultBranch, assertSafePath, assertWritableBranch } from "./policy";
import { addMinutesIso, bytesFromContent, decodeBase64, encodeBase64, nowIso, slugify, truncateUtf8, tryDecodeText } from "./utils";
import { insertChangePlan, getChangePlan, markPlanApplied, markPlanFailed, type StoredChangePlan } from "./db";
import { generatedBranchPrefix, planLimits } from "./config";

export const fileChangeSchema = z.object({
  path: z.string().min(1).max(1024),
  operation: z.enum(["create", "update", "delete"]),
  content: z.string().optional(),
  contentEncoding: z.enum(["utf-8", "base64"]).default("utf-8"),
  mode: z.enum(["100644", "100755", "120000"]).optional()
}).superRefine((value, ctx) => {
  if (value.operation !== "delete" && value.content === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "content is required for create and update" });
  }
});

export const createChangePlanSchema = z.object({
  owner: z.string().min(1),
  repository: z.string().min(1),
  baseBranch: z.string().min(1).default("main"),
  proposedBranch: z.string().optional(),
  commitMessage: z.string().min(3).max(300),
  titleHint: z.string().max(100).optional(),
  files: z.array(fileChangeSchema).min(1)
});

export const applyChangePlanSchema = z.object({
  expectedBaseSha: z.string().min(7),
  confirmation: z.string().min(1)
});

export type FileChange = z.infer<typeof fileChangeSchema>;
export type CreateChangePlanInput = z.infer<typeof createChangePlanSchema>;

interface GitHubContentFile {
  type: "file";
  path: string;
  sha: string;
  content: string;
  encoding: string;
  size: number;
}

interface GitRefResponse { object: { sha: string; type: string } }
interface GitCommitResponse { sha: string; tree: { sha: string } }
interface GitTreeResponse {
  sha: string;
  truncated: boolean;
  tree: Array<{ path: string; mode: string; type: string; sha: string | null }>;
}

function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function generatedBranch(env: Env, message: string): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${generatedBranchPrefix(env)}${slugify(message)}-${date}-${crypto.randomUUID().slice(0, 6)}`;
}

async function readFileAtRef(client: GitHubClient, owner: string, repository: string, path: string, ref: string): Promise<GitHubContentFile | undefined> {
  try {
    const result = await client.request<GitHubContentFile | unknown[]>(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
      { owner, repository, query: { ref } }
    );
    if (Array.isArray(result)) throw new AppError(`${path} is a directory, not a file`);
    if (result.type !== "file") throw new AppError(`${path} is not a regular file`);
    if (result.encoding !== "base64" || !result.content) {
      const blob = await client.request<{ content: string; encoding: string; size: number }>(
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/blobs/${result.sha}`,
        { owner, repository }
      );
      if (blob.encoding !== "base64") throw new AppError(`Unsupported GitHub blob encoding for ${path}`);
      return { ...result, content: blob.content, encoding: blob.encoding, size: blob.size };
    }
    return result;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function createChangePlan(env: Env, input: CreateChangePlanInput): Promise<StoredChangePlan> {
  const limits = planLimits(env);
  if (input.files.length > limits.maxFiles) {
    throw new AppError(`A change plan may contain at most ${limits.maxFiles} files`, 413, "plan_too_large");
  }
  const uniquePaths = new Set<string>();
  let totalBytes = 0;
  for (const file of input.files) {
    assertSafePath(env, file.path);
    if (uniquePaths.has(file.path)) throw new AppError(`Duplicate path in plan: ${file.path}`);
    uniquePaths.add(file.path);
    if (file.content !== undefined) totalBytes += bytesFromContent(file.content, file.contentEncoding).byteLength;
  }
  if (totalBytes > limits.maxBytes) {
    throw new AppError(`Proposed content exceeds ${limits.maxBytes} bytes`, 413, "plan_too_large");
  }

  const proposedBranch = input.proposedBranch || generatedBranch(env, input.titleHint || input.commitMessage);
  assertWritableBranch(env, proposedBranch);
  const client = new GitHubClient(env);
  const repository = await client.request<{ default_branch: string | null }>(
    "GET",
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`,
    { owner: input.owner, repository: input.repository }
  );
  assertNotDefaultBranch(proposedBranch, repository.default_branch);
  const baseRef = await client.request<GitRefResponse>(
    "GET",
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/git/ref/heads/${encodeRef(input.baseBranch)}`,
    { owner: input.owner, repository: input.repository }
  );

  const normalizedChanges: Array<FileChange & { oldSha?: string; oldSize?: number; existed: boolean }> = [];
  const patches: string[] = [];
  let additions = 0;
  let deletions = 0;
  const warnings: string[] = [];

  for (const file of input.files) {
    const existing = await readFileAtRef(client, input.owner, input.repository, file.path, baseRef.object.sha);
    if (file.operation === "create" && existing) throw new AppError(`Cannot create existing file: ${file.path}`, 409, "file_exists");
    if ((file.operation === "update" || file.operation === "delete") && !existing) {
      throw new AppError(`Cannot ${file.operation} missing file: ${file.path}`, 409, "file_missing");
    }

    const oldBytes = existing ? decodeBase64(existing.content) : new Uint8Array();
    const newBytes = file.operation === "delete"
      ? new Uint8Array()
      : bytesFromContent(file.content ?? "", file.contentEncoding);
    const oldText = tryDecodeText(oldBytes);
    const newText = tryDecodeText(newBytes);

    if (oldText !== undefined && newText !== undefined) {
      const patch = createTwoFilesPatch(`a/${file.path}`, `b/${file.path}`, oldText, newText, "base", "proposed", { context: 3 });
      patches.push(patch);
      for (const line of patch.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
        if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
      }
    } else {
      patches.push(`Binary change: ${file.path} (${oldBytes.byteLength} bytes -> ${newBytes.byteLength} bytes)\n`);
      warnings.push(`${file.path} is binary; no textual patch is available.`);
    }

    normalizedChanges.push({
      ...file,
      existed: Boolean(existing),
      ...(existing ? { oldSha: existing.sha, oldSize: existing.size } : {})
    });
  }

  const truncated = truncateUtf8(patches.join("\n"), limits.maxDiffBytes);
  if (truncated.truncated) warnings.push("Combined diff was truncated by MAX_DIFF_BYTES.");
  const createdAt = nowIso();
  const plan: StoredChangePlan = {
    id: crypto.randomUUID(),
    owner: input.owner,
    repository: input.repository,
    baseBranch: input.baseBranch,
    baseSha: baseRef.object.sha,
    proposedBranch,
    commitMessage: input.commitMessage,
    changes: normalizedChanges,
    summary: {
      filesChanged: input.files.length,
      additions,
      deletions,
      proposedBytes: totalBytes,
      warnings,
      branchMode: proposedBranch === input.baseBranch ? "update" : "create",
      confirmation: `APPLY ${input.owner}/${input.repository} ${proposedBranch}`
    },
    diff: truncated.value,
    status: "pending",
    createdAt,
    expiresAt: addMinutesIso(limits.ttlMinutes)
  };
  await insertChangePlan(env, plan);
  return plan;
}

export async function applyChangePlan(env: Env, planId: string, expectedBaseSha: string): Promise<Record<string, unknown>> {
  const plan = await getChangePlan(env, planId);
  if (plan.status !== "pending") throw new AppError(`Change plan is ${plan.status}`, 409, "invalid_plan_status");
  if (plan.baseSha !== expectedBaseSha) throw new AppError("expectedBaseSha does not match the previewed plan", 409, "base_sha_mismatch");

  const client = new GitHubClient(env);
  try {
    const repository = await client.request<{ default_branch: string | null }>(
      "GET",
      `/repos/${encodeURIComponent(plan.owner)}/${encodeURIComponent(plan.repository)}`,
      { owner: plan.owner, repository: plan.repository }
    );
    assertWritableBranch(env, plan.proposedBranch);
    assertNotDefaultBranch(plan.proposedBranch, repository.default_branch);

    const currentBase = await client.request<GitRefResponse>(
      "GET",
      `/repos/${encodeURIComponent(plan.owner)}/${encodeURIComponent(plan.repository)}/git/ref/heads/${encodeRef(plan.baseBranch)}`,
      { owner: plan.owner, repository: plan.repository }
    );
    if (currentBase.object.sha !== plan.baseSha) {
      throw new AppError("Base branch moved after preview. Create a new change plan.", 409, "stale_change_plan", {
        previewedSha: plan.baseSha,
        currentSha: currentBase.object.sha
      });
    }

    const updateExistingBranch = plan.proposedBranch === plan.baseBranch;
    if (updateExistingBranch) {
      assertWritableBranch(env, plan.baseBranch);
    } else {
      try {
        await client.request(
          "GET",
          `/repos/${encodeURIComponent(plan.owner)}/${encodeURIComponent(plan.repository)}/git/ref/heads/${encodeRef(plan.proposedBranch)}`,
          { owner: plan.owner, repository: plan.repository }
        );
        throw new AppError(`Branch already exists: ${plan.proposedBranch}`, 409, "branch_exists");
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    const baseCommit = await client.request<GitCommitResponse>(
      "GET",
      `/repos/${encodeURIComponent(plan.owner)}/${encodeURIComponent(plan.repository)}/git/commits/${plan.baseSha}`,
      { owner: plan.owner, repository: plan.repository }
    );
    const baseTree = await client.request<GitTreeResponse>(
      "GET",
      `/repos/${encodeURIComponent(plan.owner)}/${encodeURIComponent(plan.repository)}/git/trees/${baseCommit.tree.sha}`,
      { owner: plan.owner, repository: plan.repository, query: { recursive: 1 } }
    );
    const treeByPath = new Map(baseTree.tree.map((entry) => [entry.path, entry]));
    if (baseTree.truncated) {
      const missingExisting = (plan.changes as Array<FileChange & { existed: boolean }>).some(
        (change) => change.existed && !treeByPath.has(change.path)
      );
      if (missingExisting) {
        throw new AppError("GitHub returned a truncated tree. Reduce repository scope or split the change plan.", 409, "truncated_tree");
      }
    }

    const entries = await Promise.all((plan.changes as Array<FileChange & { existed: boolean }>).map(async (change) => {
      const existingEntry = treeByPath.get(change.path);
      if (change.operation === "delete") {
        return {
          path: change.path,
          mode: existingEntry?.mode ?? "100644",
          type: existingEntry?.type ?? "blob",
          sha: null
        };
      }
      const bytes = bytesFromContent(change.content ?? "", change.contentEncoding);
      const blob = await client.request<{ sha: string }>(
        "POST",
        `/repos/${encodeURIComponent(plan.owner)}/${encodeURIComponent(plan.repository)}/git/blobs`,
        {
          owner: plan.owner,
          repository: plan.repository,
          body: { content: encodeBase64(bytes), encoding: "base64" }
        }
      );
      return {
        path: change.path,
        mode: change.mode ?? existingEntry?.mode ?? "100644",
        type: "blob",
        sha: blob.sha
      };
    }));

    const newTree = await client.request<{ sha: string }>(
      "POST",
      `/repos/${encodeURIComponent(plan.owner)}/${encodeURIComponent(plan.repository)}/git/trees`,
      {
        owner: plan.owner,
        repository: plan.repository,
        body: { base_tree: baseCommit.tree.sha, tree: entries }
      }
    );
    const commit = await client.request<{ sha: string; html_url: string }>(
      "POST",
      `/repos/${encodeURIComponent(plan.owner)}/${encodeURIComponent(plan.repository)}/git/commits`,
      {
        owner: plan.owner,
        repository: plan.repository,
        body: { message: plan.commitMessage, tree: newTree.sha, parents: [plan.baseSha] }
      }
    );
    if (updateExistingBranch) {
      await client.request(
        "PATCH",
        `/repos/${encodeURIComponent(plan.owner)}/${encodeURIComponent(plan.repository)}/git/refs/heads/${encodeRef(plan.proposedBranch)}`,
        {
          owner: plan.owner,
          repository: plan.repository,
          body: { sha: commit.sha, force: false }
        }
      );
    } else {
      await client.request(
        "POST",
        `/repos/${encodeURIComponent(plan.owner)}/${encodeURIComponent(plan.repository)}/git/refs`,
        {
          owner: plan.owner,
          repository: plan.repository,
          body: { ref: `refs/heads/${plan.proposedBranch}`, sha: commit.sha }
        }
      );
    }
    await markPlanApplied(env, plan.id, commit.sha);
    return {
      planId: plan.id,
      owner: plan.owner,
      repository: plan.repository,
      branch: plan.proposedBranch,
      commitSha: commit.sha,
      commitUrl: commit.html_url,
      baseSha: plan.baseSha,
      branchMode: updateExistingBranch ? "update" : "create"
    };
  } catch (error) {
    await markPlanFailed(env, plan.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

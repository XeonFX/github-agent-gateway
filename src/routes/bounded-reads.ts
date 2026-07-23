import { createTwoFilesPatch } from "diff";
import { Hono } from "hono";

import type { AppVariables, Env, GitHubErrorBody, GitHubRequestOptions } from "../types";
import { GitHubClient } from "../github/client";
import { AppError, GitHubApiError, isNotFound } from "../errors";
import { assertReadablePath, assertSafeRef } from "../policy";
import { decodeBase64, safeJsonParse, truncateUtf8, tryDecodeText } from "../utils";
import { readBoundedText } from "../response-limits";
import {
  allowedWorkflows,
  branchWritePolicy,
  envBool,
  generatedBranchPrefix,
  planLimits,
  protectedBranches,
  responseLimits,
  writableBranchPrefixes
} from "../config";
import { issueNumberSchema } from "../schemas";
import { repoFromContext } from "./common";

interface GitTreeItem {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
  url?: string;
}

interface GitTreeResponse {
  sha: string;
  tree: GitTreeItem[];
  truncated: boolean;
}

interface CompareFile {
  sha: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  previous_filename?: string;
  patch?: string;
}

interface CompareCommit {
  sha: string;
  html_url?: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
    committer?: { name?: string; date?: string };
  };
  author?: { login?: string } | null;
  committer?: { login?: string } | null;
}

interface CompareResponse {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  base_commit?: { sha: string };
  merge_base_commit?: { sha: string };
  commits?: CompareCommit[];
  files?: CompareFile[];
}

interface GitHubContentFile {
  type: "file";
  sha: string;
  content?: string;
  encoding?: string;
}

interface GitHubBlob {
  content: string;
  encoding: string;
}

export const boundedReadRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function integerQuery(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function booleanQuery(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function repoPath(owner: string, repository: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

async function boundedJson<T>(
  client: GitHubClient,
  path: string,
  options: GitHubRequestOptions,
  maxBytes: number
): Promise<T> {
  const response = await client.requestResponse("GET", path, options);
  const text = await readBoundedText(response, maxBytes);
  if (!response.ok) {
    const details = safeJsonParse<GitHubErrorBody | string>(text, text);
    const message = typeof details === "object" && details?.message
      ? details.message
      : `GitHub API request failed with status ${response.status}`;
    throw new GitHubApiError(
      message,
      response.status,
      response.headers.get("x-github-request-id") ?? undefined,
      details
    );
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError("GitHub returned invalid JSON", 500, "github_invalid_response");
  }
}

function compactTreeItem(item: GitTreeItem, includeUrls: boolean): Record<string, unknown> {
  return {
    path: item.path,
    mode: item.mode,
    type: item.type,
    sha: item.sha,
    ...(item.size !== undefined ? { size: item.size } : {}),
    ...(includeUrls && item.url ? { url: item.url } : {})
  };
}

function compactCommit(item: CompareCommit): Record<string, unknown> {
  return {
    sha: item.sha,
    message: item.commit?.message,
    author: item.commit?.author,
    committer: item.commit?.committer,
    authorLogin: item.author?.login,
    committerLogin: item.committer?.login,
    htmlUrl: item.html_url
  };
}

function compactFiles(files: CompareFile[], includePatch: boolean, maxPatchBytes: number): Record<string, unknown>[] {
  let remainingPatchBytes = maxPatchBytes;
  return files.map((file) => {
    const compact: Record<string, unknown> = {
      sha: file.sha,
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      previousFilename: file.previous_filename
    };
    if (includePatch && file.patch) {
      const budget = Math.min(32 * 1024, remainingPatchBytes);
      if (budget > 0) {
        const bounded = truncateUtf8(file.patch, budget);
        compact.patch = bounded.value;
        compact.patchTruncated = bounded.truncated;
        remainingPatchBytes -= new TextEncoder().encode(bounded.value).byteLength;
      } else {
        compact.patchTruncated = true;
      }
    }
    return compact;
  });
}

async function getTree(
  client: GitHubClient,
  owner: string,
  repository: string,
  sha: string,
  recursive: boolean,
  maxBytes: number
): Promise<GitTreeResponse> {
  return boundedJson<GitTreeResponse>(
    client,
    `${repoPath(owner, repository)}/git/trees/${encodeURIComponent(sha)}`,
    { owner, repository, query: { recursive: recursive ? 1 : undefined } },
    maxBytes
  );
}

async function resolveTreeSha(
  client: GitHubClient,
  owner: string,
  repository: string,
  ref: string,
  treeSha: string | undefined,
  maxBytes: number
): Promise<string> {
  if (treeSha) {
    if (!/^[a-f0-9]{40}$/i.test(treeSha)) throw new AppError("treeSha must be a 40-character Git SHA");
    return treeSha;
  }
  assertSafeRef(ref);
  const commit = await boundedJson<{ commit: { tree: { sha: string } } }>(
    client,
    `${repoPath(owner, repository)}/commits/${encodeURIComponent(ref)}`,
    { owner, repository },
    maxBytes
  );
  return commit.commit.tree.sha;
}

async function resolveSubtreeSha(
  client: GitHubClient,
  owner: string,
  repository: string,
  rootSha: string,
  path: string,
  maxBytes: number
): Promise<string> {
  let currentSha = rootSha;
  for (const segment of path.split("/").filter(Boolean)) {
    const tree = await getTree(client, owner, repository, currentSha, false, maxBytes);
    const next = tree.tree.find((item) => item.path === segment);
    if (!next) throw new AppError(`Tree path not found: ${path}`, 404, "tree_path_not_found");
    if (next.type !== "tree") throw new AppError(`Tree path is not a directory: ${path}`, 400, "not_a_tree");
    currentSha = next.sha;
  }
  return currentSha;
}

async function readTextAtRef(
  client: GitHubClient,
  owner: string,
  repository: string,
  path: string,
  ref: string,
  maxBytes: number
): Promise<{ exists: boolean; text: string; sha?: string }> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  let file: GitHubContentFile;
  try {
    const result = await boundedJson<GitHubContentFile | unknown[]>(
      client,
      `${repoPath(owner, repository)}/contents/${encodedPath}`,
      { owner, repository, query: { ref } },
      maxBytes
    );
    if (Array.isArray(result) || result.type !== "file") {
      throw new AppError(`Path is not a file: ${path}`, 400, "not_a_file");
    }
    file = result;
  } catch (error) {
    if (isNotFound(error)) return { exists: false, text: "" };
    throw error;
  }

  let content = file.content;
  let encoding = file.encoding;
  if (!content) {
    const blob = await boundedJson<GitHubBlob>(
      client,
      `${repoPath(owner, repository)}/git/blobs/${encodeURIComponent(file.sha)}`,
      { owner, repository },
      maxBytes
    );
    content = blob.content;
    encoding = blob.encoding;
  }
  if (encoding !== "base64") {
    throw new AppError(`Unsupported content encoding for ${path}`, 400, "unsupported_content_encoding");
  }
  const text = tryDecodeText(decodeBase64(content));
  if (text === undefined) throw new AppError(`Binary files cannot be diffed: ${path}`, 400, "binary_file");
  return { exists: true, text, sha: file.sha };
}

boundedReadRoutes.get("/capabilities", (c) => {
  return c.json({
    service: "github-agent-gateway",
    version: "1.2.0",
    repositoryAccess: {
      source: "github_app_installations",
      installationMode: c.env.GITHUB_INSTALLATION_ID?.trim() ? "fixed" : "all_app_installations",
      namesExposedInCapabilities: false
    },
    branchPolicy: {
      mode: branchWritePolicy(c.env),
      writablePrefixes: writableBranchPrefixes(c.env),
      generatedPrefix: generatedBranchPrefix(c.env),
      protectedBranches: [...protectedBranches(c.env)],
      defaultBranchWritesAllowed: false
    },
    limits: { ...planLimits(c.env), ...responseLimits(c.env) },
    workflows: {
      writeEnabled: envBool(c.env.ENABLE_WORKFLOW_WRITE),
      fileChangesEnabled: envBool(c.env.ENABLE_WORKFLOW_FILE_CHANGES),
      allowlist: [...allowedWorkflows(c.env)]
    },
    features: {
      merge: envBool(c.env.ENABLE_MERGE),
      destructiveOperations: envBool(c.env.ENABLE_DESTRUCTIVE_OPERATIONS),
      administration: envBool(c.env.ENABLE_ADMIN_OPERATIONS)
    }
  });
});

boundedReadRoutes.get("/repos/:owner/:repository/tree", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const limits = responseLimits(c.env);
  const ref = c.req.query("ref") || "HEAD";
  const treeSha = c.req.query("treeSha");
  const path = (c.req.query("path") || "").replace(/^\/+|\/+$/g, "");
  if (path) assertReadablePath(path);
  const recursive = booleanQuery(c.req.query("recursive"), false);
  const includeUrls = booleanQuery(c.req.query("includeUrls"), false);
  const cursor = integerQuery(c.req.query("cursor"), 0, 0, 1_000_000, "cursor");
  const limit = integerQuery(c.req.query("limit"), Math.min(limits.defaultReadPageSize, 1000), 1, 1000, "limit");

  const client = new GitHubClient(c.env);
  const rootSha = await resolveTreeSha(client, owner, repository, ref, treeSha, limits.maxUpstreamResponseBytes);
  const selectedSha = path
    ? await resolveSubtreeSha(client, owner, repository, rootSha, path, limits.maxUpstreamResponseBytes)
    : rootSha;
  const result = await getTree(client, owner, repository, selectedSha, recursive, limits.maxUpstreamResponseBytes);
  const selected = result.tree.slice(cursor, cursor + limit).map((item) => compactTreeItem(item, includeUrls));
  const nextCursor = cursor + limit < result.tree.length ? cursor + limit : undefined;

  return c.json({
    sha: result.sha,
    rootSha,
    path,
    recursive,
    tree: selected,
    page: { cursor, limit, nextCursor, truncated: nextCursor !== undefined || result.truncated },
    upstreamTruncated: result.truncated,
    omitted: includeUrls ? [] : ["tree.url"]
  });
});

boundedReadRoutes.get("/repos/:owner/:repository/compare/file", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const base = c.req.query("base");
  const head = c.req.query("head");
  const path = c.req.query("path");
  if (!base || !head || !path) throw new AppError("base, head and path query parameters are required");
  assertSafeRef(base);
  assertSafeRef(head);
  assertReadablePath(path);
  const context = integerQuery(c.req.query("context"), 3, 0, 20, "context");
  const limits = responseLimits(c.env);
  const client = new GitHubClient(c.env);
  const [before, after] = await Promise.all([
    readTextAtRef(client, owner, repository, path, base, limits.maxUpstreamResponseBytes),
    readTextAtRef(client, owner, repository, path, head, limits.maxUpstreamResponseBytes)
  ]);
  if (!before.exists && !after.exists) throw new AppError(`File does not exist at either ref: ${path}`, 404, "file_not_found");

  const status = !before.exists ? "added" : !after.exists ? "deleted" : before.text === after.text ? "unchanged" : "modified";
  const patch = createTwoFilesPatch(
    before.exists ? path : "/dev/null",
    after.exists ? path : "/dev/null",
    before.text,
    after.text,
    base,
    head,
    { context }
  );
  const bounded = truncateUtf8(patch, limits.maxPatchBytes);
  return c.json({
    path,
    base,
    head,
    status,
    baseSha: before.sha,
    headSha: after.sha,
    patch: bounded.value,
    patchTruncated: bounded.truncated
  });
});

boundedReadRoutes.get("/repos/:owner/:repository/compare", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const base = c.req.query("base");
  const head = c.req.query("head");
  if (!base || !head) throw new AppError("base and head query parameters are required");
  assertSafeRef(base);
  assertSafeRef(head);

  const view = c.req.query("view") || "summary";
  if (!(["summary", "files", "commits"] as const).includes(view as "summary" | "files" | "commits")) {
    throw new AppError("view must be summary, files or commits");
  }
  const limits = responseLimits(c.env);
  const cursor = integerQuery(c.req.query("cursor"), 0, 0, 1_000_000, "cursor");
  const limit = integerQuery(c.req.query("limit"), Math.min(limits.defaultReadPageSize, 100), 1, 100, "limit");
  const includePatch = booleanQuery(c.req.query("includePatch"), false);
  const pathPrefix = (c.req.query("pathPrefix") || "").replace(/^\/+/, "");
  const readablePrefix = pathPrefix.replace(/\/+$/, "");
  if (readablePrefix) assertReadablePath(readablePrefix);

  const client = new GitHubClient(c.env);
  const compareUrl = `${repoPath(owner, repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;

  if (view === "summary") {
    const result = await boundedJson<CompareResponse>(
      client,
      compareUrl,
      { owner, repository, query: { per_page: 1, page: 2 } },
      limits.maxUpstreamResponseBytes
    );
    return c.json({
      status: result.status,
      aheadBy: result.ahead_by,
      behindBy: result.behind_by,
      totalCommits: result.total_commits,
      baseSha: result.base_commit?.sha,
      headRef: head,
      mergeBaseSha: result.merge_base_commit?.sha,
      view,
      omitted: ["files", "commits"]
    });
  }

  if (view === "commits") {
    const githubPageSize = 100;
    const githubPage = Math.floor(cursor / githubPageSize) + 1;
    const offset = cursor % githubPageSize;
    const result = await boundedJson<CompareResponse>(
      client,
      compareUrl,
      { owner, repository, query: { per_page: githubPageSize, page: githubPage } },
      limits.maxUpstreamResponseBytes
    );
    const commits = result.commits ?? [];
    const selected = commits.slice(offset, offset + limit).map(compactCommit);
    const nextCursor = offset + limit < commits.length
      ? cursor + limit
      : commits.length === githubPageSize
        ? githubPage * githubPageSize
        : undefined;
    return c.json({
      status: result.status,
      aheadBy: result.ahead_by,
      behindBy: result.behind_by,
      totalCommits: result.total_commits,
      baseSha: result.base_commit?.sha,
      mergeBaseSha: result.merge_base_commit?.sha,
      view,
      commits: selected,
      page: { cursor, limit, nextCursor, truncated: nextCursor !== undefined },
      omitted: ["files"]
    });
  }

  const result = await boundedJson<CompareResponse>(
    client,
    compareUrl,
    { owner, repository, query: { per_page: 1, page: 1 } },
    limits.maxUpstreamResponseBytes
  );
  const files = (result.files ?? []).filter((file) => !pathPrefix || file.filename.startsWith(pathPrefix));
  const selected = files.slice(cursor, cursor + limit);
  const nextCursor = cursor + limit < files.length ? cursor + limit : undefined;
  return c.json({
    status: result.status,
    aheadBy: result.ahead_by,
    behindBy: result.behind_by,
    totalCommits: result.total_commits,
    baseSha: result.base_commit?.sha,
    mergeBaseSha: result.merge_base_commit?.sha,
    view,
    files: compactFiles(selected, includePatch, limits.maxPatchBytes),
    page: { cursor, limit, nextCursor, truncated: nextCursor !== undefined || files.length >= 300 },
    upstreamFileLimitReached: (result.files?.length ?? 0) >= 300,
    omitted: includePatch ? [] : ["files.patch"]
  });
});

boundedReadRoutes.get("/repos/:owner/:repository/pulls/:number/files", async (c) => {
  const { owner, repository } = repoFromContext(c);
  const number = issueNumberSchema.parse(c.req.param("number"));
  const page = integerQuery(c.req.query("page"), 1, 1, 30, "page");
  const perPage = integerQuery(c.req.query("perPage"), 50, 1, 100, "perPage");
  const includePatch = booleanQuery(c.req.query("includePatch"), false);
  const limits = responseLimits(c.env);
  const files = await boundedJson<CompareFile[]>(
    new GitHubClient(c.env),
    `${repoPath(owner, repository)}/pulls/${number}/files`,
    { owner, repository, query: { page, per_page: perPage } },
    limits.maxUpstreamResponseBytes
  );
  const nextPage = files.length === perPage && page < 30 ? page + 1 : undefined;
  return c.json({
    number,
    files: compactFiles(files, includePatch, limits.maxPatchBytes),
    page: { page, perPage, nextPage, truncated: nextPage !== undefined },
    omitted: includePatch ? [] : ["files.patch"]
  });
});

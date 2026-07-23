const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);

export const CHATGPT_OPERATION_IDS = [
  "getCapabilities",
  "listRepositories",
  "getRepository",
  "getContents",
  "getTree",
  "listBranches",
  "createBranch",
  "listCommits",
  "getCommit",
  "compareRefs",
  "getFileDiff",
  "createChangePlan",
  "getChangePlan",
  "applyChangePlan",
  "listPullRequests",
  "createPullRequest",
  "getPullRequest",
  "listPullRequestFiles",
  "updatePullRequest",
  "commentOnPullRequest",
  "listIssues",
  "createIssue",
  "getIssue",
  "updateIssue",
  "commentOnIssue",
  "listWorkflows",
  "dispatchWorkflow",
  "listWorkflowRuns",
  "getWorkflowRun",
  "rerunWorkflowRun"
] as const;

type OpenApiOperation = Record<string, unknown> & { operationId?: string; parameters?: unknown };
type OpenApiPathItem = Record<string, unknown>;

export type OpenApiDocument = Record<string, unknown> & {
  info: Record<string, unknown> & { title?: string; description?: string };
  paths: Record<string, OpenApiPathItem>;
};

function parameter(name: string, location: "path" | "query", required: boolean, schema: Record<string, unknown>, description?: string) {
  return { name, in: location, required, schema, ...(description ? { description } : {}) };
}

const ownerParameter = parameter("owner", "path", true, { type: "string" });
const repositoryParameter = parameter("repository", "path", true, { type: "string" });
const numberParameter = parameter("number", "path", true, { type: "integer", minimum: 1 });

function objectKey(value: unknown): string | undefined {
  if (!isOperation(value)) return undefined;
  const name = typeof value.name === "string" ? value.name : undefined;
  const location = typeof value.in === "string" ? value.in : undefined;
  return name && location ? `${location}:${name}` : undefined;
}

function mergeParameters(existing: unknown, additions: unknown[]): unknown[] {
  const values = Array.isArray(existing) ? [...existing] : [];
  const keys = new Set(values.map(objectKey).filter((key): key is string => Boolean(key)));
  for (const addition of additions) {
    const key = objectKey(addition);
    if (!key || !keys.has(key)) values.push(addition);
    if (key) keys.add(key);
  }
  return values;
}

function extendGetOperation(
  paths: Record<string, OpenApiPathItem>,
  path: string,
  additions: unknown[],
  description: string
): void {
  const pathItem = paths[path] ?? {};
  const get = isOperation(pathItem.get) ? pathItem.get : {};
  paths[path] = {
    ...pathItem,
    get: { ...get, description, parameters: mergeParameters(get.parameters, additions) }
  };
}

function addReadExtensions(document: OpenApiDocument): OpenApiDocument {
  const paths = { ...document.paths };

  extendGetOperation(
    paths,
    "/v1/repos/{owner}/{repository}/tree",
    [
      parameter("treeSha", "query", false, { type: "string", pattern: "^[a-fA-F0-9]{40}$" }, "Direct Git tree SHA; bypasses commit resolution."),
      parameter("path", "query", false, { type: "string" }, "Directory path to traverse before listing."),
      parameter("cursor", "query", false, { type: "integer", minimum: 0, default: 0 }),
      parameter("limit", "query", false, { type: "integer", minimum: 1, maximum: 1000 }),
      parameter("includeUrls", "query", false, { type: "boolean", default: false })
    ],
    "Lists a bounded tree page. Recursive traversal is opt-in and defaults to false. Use treeSha for a raw tree object or path for directory-by-directory traversal."
  );

  extendGetOperation(
    paths,
    "/v1/repos/{owner}/{repository}/compare",
    [
      parameter("view", "query", false, { type: "string", enum: ["summary", "files", "commits"], default: "summary" }),
      parameter("cursor", "query", false, { type: "integer", minimum: 0, default: 0 }),
      parameter("limit", "query", false, { type: "integer", minimum: 1, maximum: 100 }),
      parameter("includePatch", "query", false, { type: "boolean", default: false }),
      parameter("pathPrefix", "query", false, { type: "string" })
    ],
    "Returns a compact summary by default. Request files or commits explicitly and continue with nextCursor. Patches are omitted unless includePatch=true and are byte-bounded."
  );

  paths["/v1/repos/{owner}/{repository}/compare/file"] = {
    get: {
      summary: "Diff one file between refs",
      operationId: "getFileDiff",
      description: "Fetches one file at each ref and produces a bounded local unified diff. Binary files are rejected.",
      responses: { "200": { description: "Success" } },
      parameters: [
        ownerParameter,
        repositoryParameter,
        parameter("base", "query", true, { type: "string" }),
        parameter("head", "query", true, { type: "string" }),
        parameter("path", "query", true, { type: "string" }),
        parameter("context", "query", false, { type: "integer", minimum: 0, maximum: 20, default: 3 })
      ]
    }
  };

  paths["/v1/repos/{owner}/{repository}/pulls/{number}/files"] = {
    get: {
      summary: "List pull request files",
      operationId: "listPullRequestFiles",
      description: "Returns one compact page of changed files. Patches are omitted by default and byte-bounded when requested.",
      responses: { "200": { description: "Success" } },
      parameters: [
        ownerParameter,
        repositoryParameter,
        numberParameter,
        parameter("page", "query", false, { type: "integer", minimum: 1, maximum: 30, default: 1 }),
        parameter("perPage", "query", false, { type: "integer", minimum: 1, maximum: 100, default: 50 }),
        parameter("includePatch", "query", false, { type: "boolean", default: false })
      ]
    }
  };

  return { ...document, paths };
}

export function withServer(document: OpenApiDocument, origin: string): OpenApiDocument {
  return { ...addReadExtensions(document), servers: [{ url: origin }] };
}

export function createChatGptOpenApiDocument(document: OpenApiDocument, origin: string): OpenApiDocument {
  const extended = addReadExtensions(document);
  const allowed = new Set<string>(CHATGPT_OPERATION_IDS);
  const found = new Set<string>();
  const paths: Record<string, OpenApiPathItem> = {};

  for (const [path, pathItem] of Object.entries(extended.paths)) {
    const filteredPathItem: OpenApiPathItem = {};
    if ("parameters" in pathItem) filteredPathItem.parameters = pathItem.parameters;
    for (const [key, value] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(key.toLowerCase()) || !isOperation(value)) continue;
      const operationId = value.operationId;
      if (operationId && allowed.has(operationId)) {
        filteredPathItem[key] = value;
        found.add(operationId);
      }
    }
    if (Object.keys(filteredPathItem).some((key) => key !== "parameters")) paths[path] = filteredPathItem;
  }

  const missing = CHATGPT_OPERATION_IDS.filter((operationId) => !found.has(operationId));
  if (missing.length > 0) {
    throw new Error(`ChatGPT OpenAPI operations missing from full schema: ${missing.join(", ")}`);
  }

  return {
    ...extended,
    info: {
      ...extended.info,
      title: `${extended.info.title ?? "GitHub Agent Gateway"} — ChatGPT Action`,
      description: [
        extended.info.description,
        "This schema is a curated 30-operation subset for the Custom GPT Actions limit.",
        "The subset prioritizes bounded PR-file and single-file diff reads over workflow job and log endpoints.",
        "Use /openapi.json for the complete gateway API."
      ].filter(Boolean).join("\n\n")
    },
    servers: [{ url: origin }],
    paths
  };
}

export function listOperationIds(document: OpenApiDocument): string[] {
  const operationIds: string[] = [];
  for (const pathItem of Object.values(addReadExtensions(document).paths)) {
    for (const [key, value] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(key.toLowerCase()) || !isOperation(value) || !value.operationId) continue;
      operationIds.push(value.operationId);
    }
  }
  return operationIds;
}

function isOperation(value: unknown): value is OpenApiOperation {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

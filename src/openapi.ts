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
  "createChangePlan",
  "getChangePlan",
  "applyChangePlan",
  "listPullRequests",
  "createPullRequest",
  "getPullRequest",
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
  "listWorkflowRunJobs",
  "getWorkflowLogsUrl",
  "rerunWorkflowRun"
] as const;

type OpenApiOperation = Record<string, unknown> & { operationId?: string };
type OpenApiPathItem = Record<string, unknown>;
export type OpenApiDocument = Record<string, unknown> & {
  info: Record<string, unknown> & {
    title?: string;
    description?: string;
  };
  paths: Record<string, OpenApiPathItem>;
};

export function withServer(document: OpenApiDocument, origin: string): OpenApiDocument {
  return {
    ...document,
    servers: [{ url: origin }]
  };
}

export function createChatGptOpenApiDocument(document: OpenApiDocument, origin: string): OpenApiDocument {
  const allowed = new Set<string>(CHATGPT_OPERATION_IDS);
  const found = new Set<string>();
  const paths: Record<string, OpenApiPathItem> = {};

  for (const [path, pathItem] of Object.entries(document.paths)) {
    const filteredPathItem: OpenApiPathItem = {};

    if ("parameters" in pathItem) {
      filteredPathItem.parameters = pathItem.parameters;
    }

    for (const [key, value] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(key.toLowerCase()) || !isOperation(value)) {
        continue;
      }

      const operationId = value.operationId;
      if (operationId && allowed.has(operationId)) {
        filteredPathItem[key] = value;
        found.add(operationId);
      }
    }

    if (Object.keys(filteredPathItem).some((key) => key !== "parameters")) {
      paths[path] = filteredPathItem;
    }
  }

  const missing = CHATGPT_OPERATION_IDS.filter((operationId) => !found.has(operationId));
  if (missing.length > 0) {
    throw new Error(`ChatGPT OpenAPI operations missing from full schema: ${missing.join(", ")}`);
  }

  return {
    ...document,
    info: {
      ...document.info,
      title: `${document.info.title ?? "GitHub Agent Gateway"} — ChatGPT Action`,
      description: [
        document.info.description,
        "This schema is a curated 30-operation subset for the Custom GPT Actions limit.",
        "Use /openapi.json for the complete gateway API."
      ].filter(Boolean).join("\n\n")
    },
    servers: [{ url: origin }],
    paths
  };
}

export function listOperationIds(document: OpenApiDocument): string[] {
  const operationIds: string[] = [];

  for (const pathItem of Object.values(document.paths)) {
    for (const [key, value] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(key.toLowerCase()) || !isOperation(value) || !value.operationId) {
        continue;
      }
      operationIds.push(value.operationId);
    }
  }

  return operationIds;
}

function isOperation(value: unknown): value is OpenApiOperation {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

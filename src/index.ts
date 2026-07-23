import { Hono } from "hono";
import { z, ZodError } from "zod/v4";

import type { AppVariables, Env } from "./types";
import { AppError, GitHubApiError } from "./errors";
import { constantTimeEqual } from "./utils";
import {
  allowedWorkflows,
  branchWritePolicy,
  envBool,
  generatedBranchPrefix,
  planLimits,
  protectedBranches,
  requireSecrets,
  responseLimits,
  writableBranchPrefixes
} from "./config";
import { assertResponseWithinLimit } from "./response-limits";
import { SERVICE_VERSION } from "./version";
import openapiBase from "../openapi.action.json";
import { createChatGptOpenApiDocument, withServer, type OpenApiDocument } from "./openapi";
import { boundedReadRoutes } from "./routes/bounded-reads";
import { repositoryRoutes } from "./routes/repositories";
import { changePlanRoutes } from "./routes/change-plans";
import { pullRoutes } from "./routes/pulls";
import { issueRoutes } from "./routes/issues";
import { actionRoutes } from "./routes/actions";
import { releaseRoutes } from "./routes/releases";
import { adminRoutes } from "./routes/admin";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
const baseDocument = openapiBase as OpenApiDocument;
const versionedOpenApiBase: OpenApiDocument = {
  ...baseDocument,
  info: { ...baseDocument.info, version: SERVICE_VERSION }
};

app.use("*", async (c, next) => {
  c.set("requestId", c.req.header("X-Request-ID") || crypto.randomUUID());
  c.header("X-Request-ID", c.get("requestId"));
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});

app.get("/health", (c) => c.json({ ok: true, service: "github-agent-gateway", version: SERVICE_VERSION }));

app.get("/openapi.json", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json(withServer(versionedOpenApiBase, origin));
});

app.get("/openapi.chatgpt.json", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json(createChatGptOpenApiDocument(versionedOpenApiBase, origin));
});

app.use("/v1/*", async (c, next) => {
  requireSecrets(c.env);
  const authorization = c.req.header("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token || !constantTimeEqual(token, c.env.ACTION_API_KEY)) {
    throw new AppError("Invalid or missing bearer token", 401, "unauthorized");
  }
  c.set("actor", c.req.header("X-Agent-Actor")?.slice(0, 100) || "agent-client");
  await next();
  if (c.res.status !== 204) {
    await assertResponseWithinLimit(c.res, responseLimits(c.env).maxActionResponseBytes);
  }
});

app.get("/v1/capabilities", (c) => c.json({
  service: "github-agent-gateway",
  version: SERVICE_VERSION,
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
}));

app.route("/v1", boundedReadRoutes);
app.route("/v1", repositoryRoutes);
app.route("/v1", changePlanRoutes);
app.route("/v1", pullRoutes);
app.route("/v1", issueRoutes);
app.route("/v1", actionRoutes);
app.route("/v1", releaseRoutes);
app.route("/v1", adminRoutes);

app.notFound((c) => c.json({
  error: { code: "not_found", message: "Route not found" },
  requestId: c.get("requestId")
}, 404));

app.onError((error, c) => {
  console.error(JSON.stringify({
    requestId: c.get("requestId"),
    error: error instanceof Error ? error.stack : String(error)
  }));

  if (error instanceof ZodError) {
    return c.json({
      error: { code: "validation_error", message: "Request validation failed", details: z.flattenError(error) },
      requestId: c.get("requestId")
    }, 422);
  }
  if (error instanceof GitHubApiError) {
    return c.json({
      error: {
        code: error.code,
        message: error.message,
        githubRequestId: error.githubRequestId,
        details: error.details
      },
      requestId: c.get("requestId")
    }, error.status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500);
  }
  if (error instanceof AppError) {
    return c.json({
      error: { code: error.code, message: error.message, details: error.details },
      requestId: c.get("requestId")
    }, error.status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500);
  }
  return c.json({
    error: { code: "internal_error", message: "Unexpected server error" },
    requestId: c.get("requestId")
  }, 500);
});

export default app;

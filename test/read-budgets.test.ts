import { describe, expect, it } from "vitest";
import openapiBase from "../openapi.action.json";
import { responseLimits } from "../src/config";
import { createChatGptOpenApiDocument, listOperationIds, withServer, type OpenApiDocument } from "../src/openapi";
import { assertResponseWithinLimit, readBoundedText } from "../src/response-limits";
import type { Env } from "../src/types";

const env = {
  MAX_ACTION_RESPONSE_BYTES: "300000",
  MAX_UPSTREAM_RESPONSE_BYTES: "9000000",
  DEFAULT_READ_PAGE_SIZE: "75",
  MAX_PATCH_BYTES: "100000"
} as Env;

describe("response limits", () => {
  it("reads configured response budgets", () => {
    expect(responseLimits(env)).toEqual({
      maxActionResponseBytes: 300000,
      maxUpstreamResponseBytes: 9000000,
      defaultReadPageSize: 75,
      maxPatchBytes: 100000
    });
  });

  it("rejects an announced upstream response before reading it", async () => {
    const response = new Response("small", { headers: { "content-length": "70000" } });
    await expect(readBoundedText(response, 65536)).rejects.toMatchObject({
      status: 413,
      code: "upstream_response_too_large"
    });
  });

  it("rejects an upstream response whose actual body exceeds the limit", async () => {
    const response = new Response("x".repeat(70000));
    await expect(readBoundedText(response, 65536)).rejects.toMatchObject({
      status: 413,
      code: "upstream_response_too_large"
    });
  });

  it("rejects an oversized action response with recovery details", async () => {
    const response = new Response("x".repeat(70000));
    await expect(assertResponseWithinLimit(response, 65536)).rejects.toMatchObject({
      status: 413,
      code: "response_too_large"
    });
  });
});

describe("bounded read OpenAPI extensions", () => {
  const fullDocument = openapiBase as OpenApiDocument;

  it("adds PR-file and single-file diff operations to the full schema", () => {
    const document = withServer(fullDocument, "https://gateway.example.com");
    const operationIds = new Set(listOperationIds(document));
    expect(operationIds.has("listPullRequestFiles")).toBe(true);
    expect(operationIds.has("getFileDiff")).toBe(true);
  });

  it("keeps the ChatGPT schema at 30 operations", () => {
    const document = createChatGptOpenApiDocument(fullDocument, "https://gateway.example.com");
    expect(listOperationIds(document)).toHaveLength(30);
    expect(document.info.description).toContain("bounded PR-file");
  });

  it("documents compact compare and non-recursive tree controls", () => {
    const document = withServer(fullDocument, "https://gateway.example.com");
    const compare = document.paths["/v1/repos/{owner}/{repository}/compare"]?.get as { parameters?: Array<{ name?: string }> };
    const tree = document.paths["/v1/repos/{owner}/{repository}/tree"]?.get as { parameters?: Array<{ name?: string }> };
    expect(compare.parameters?.map((item) => item.name)).toEqual(expect.arrayContaining(["view", "cursor", "limit", "includePatch"]));
    expect(tree.parameters?.map((item) => item.name)).toEqual(expect.arrayContaining(["treeSha", "path", "cursor", "limit"]));
  });
});

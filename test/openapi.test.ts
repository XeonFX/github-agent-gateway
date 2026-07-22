import { describe, expect, it } from "vitest";
import openapiBase from "../openapi.action.json";
import {
  CHATGPT_OPERATION_IDS,
  createChatGptOpenApiDocument,
  listOperationIds,
  type OpenApiDocument
} from "../src/openapi";

const fullDocument = openapiBase as OpenApiDocument;

describe("ChatGPT OpenAPI schema", () => {
  it("contains exactly the 30 curated operations", () => {
    const document = createChatGptOpenApiDocument(fullDocument, "https://gateway.example.com");
    const operationIds = listOperationIds(document);

    expect(operationIds).toHaveLength(30);
    expect(new Set(operationIds)).toEqual(new Set(CHATGPT_OPERATION_IDS));
  });

  it("contains only operations present in the full schema", () => {
    const fullOperationIds = new Set(listOperationIds(fullDocument));

    for (const operationId of CHATGPT_OPERATION_IDS) {
      expect(fullOperationIds.has(operationId), `${operationId} should exist in the full schema`).toBe(true);
    }
  });

  it("uses the request origin and identifies itself as the ChatGPT subset", () => {
    const document = createChatGptOpenApiDocument(fullDocument, "https://gateway.example.com");

    expect(document.servers).toEqual([{ url: "https://gateway.example.com" }]);
    expect(document.info.title).toContain("ChatGPT Action");
    expect(document.info.description).toContain("30-operation subset");
  });

  it("gives every object request body explicit properties", () => {
    const document = createChatGptOpenApiDocument(fullDocument, "https://gateway.example.com");

    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const [method, value] of Object.entries(pathItem)) {
        if (typeof value !== "object" || value === null || !("requestBody" in value)) continue;

        const operation = value as {
          requestBody?: { content?: { "application/json"?: { schema?: Record<string, unknown> } } };
        };
        const schema = operation.requestBody?.content?.["application/json"]?.schema;
        if (schema?.type === "object") {
          expect(schema.properties, `${method.toUpperCase()} ${path} should declare body properties`).toBeDefined();
          expect(Object.keys(schema.properties as object).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("omits destructive and administrative operations", () => {
    const document = createChatGptOpenApiDocument(fullDocument, "https://gateway.example.com");
    const operationIds = new Set(listOperationIds(document));

    for (const operationId of [
      "deleteBranch",
      "mergePullRequest",
      "cancelWorkflowRun",
      "deleteRelease",
      "deleteTag",
      "updateRepository",
      "updateBranchProtection",
      "upsertCollaborator"
    ]) {
      expect(operationIds.has(operationId)).toBe(false);
    }
  });
});

import { generateKeyPairSync, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createGitHubAppJwt } from "../src/github/jwt";

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("GitHub App JWT", () => {
  it("creates a valid RS256 token", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const token = createGitHubAppJwt("12345", Buffer.from(pem).toString("base64"), 1_700_000_000);
    const [header, payload, signature] = token.split(".");
    expect(decodeJson(header!).alg).toBe("RS256");
    expect(decodeJson(payload!).iss).toBe("12345");
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });
});

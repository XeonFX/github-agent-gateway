import { Buffer } from "node:buffer";
import { sign } from "node:crypto";
import { base64Url } from "../utils";
import { AppError } from "../errors";

export function decodePrivateKey(base64Value: string): string {
  try {
    const pem = Buffer.from(base64Value, "base64").toString("utf8").trim();
    if (!pem.includes("BEGIN") || !pem.includes("PRIVATE KEY")) throw new Error("not a PEM key");
    return pem + "\n";
  } catch (error) {
    throw new AppError("GITHUB_PRIVATE_KEY_BASE64 is invalid", 500, "configuration_error", String(error));
  }
}

export function createGitHubAppJwt(appId: string, privateKeyBase64: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: appId
  }));
  const unsigned = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), decodePrivateKey(privateKeyBase64));
  return `${unsigned}.${signature.toString("base64url")}`;
}

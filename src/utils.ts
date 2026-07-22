import { Buffer } from "node:buffer";
import { AppError } from "./errors";

export function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

export function base64Url(input: string | Uint8Array): string {
  const value = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return value.toString("base64url");
}

export function decodeBase64(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input.replace(/\n/g, ""), "base64"));
}

export function encodeBase64(input: Uint8Array): string {
  return Buffer.from(input).toString("base64");
}

export function bytesFromContent(content: string, encoding: "utf-8" | "base64"): Uint8Array {
  if (encoding === "base64") return decodeBase64(content);
  return new TextEncoder().encode(content);
}

export function tryDecodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addMinutesIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return slug || "change";
}

export function assertExactConfirmation(actual: string | undefined, expected: string): void {
  if (!actual || !constantTimeEqual(actual, expected)) {
    throw new AppError(`Confirmation must exactly equal: ${expected}`, 409, "confirmation_required", { expected });
  }
}

export function assertStringRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  const sliced = bytes.slice(0, maxBytes);
  return { value: new TextDecoder().decode(sliced) + "\n... diff truncated ...\n", truncated: true };
}

export function getIdempotencyKey(headers: Headers): string | undefined {
  const key = headers.get("Idempotency-Key")?.trim();
  if (!key) return undefined;
  if (key.length > 200) throw new AppError("Idempotency-Key is too long");
  return key;
}

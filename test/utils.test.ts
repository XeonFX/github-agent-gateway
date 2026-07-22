import { describe, expect, it } from "vitest";
import { constantTimeEqual, bytesFromContent, tryDecodeText, truncateUtf8 } from "../src/utils";

describe("utilities", () => {
  it("compares secrets", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
  });

  it("handles UTF-8 and base64 content", () => {
    expect(tryDecodeText(bytesFromContent("hello", "utf-8"))).toBe("hello");
    expect(tryDecodeText(bytesFromContent("aGVsbG8=", "base64"))).toBe("hello");
    expect(tryDecodeText(new Uint8Array([0, 1, 2]))).toBeUndefined();
  });

  it("truncates by bytes", () => {
    expect(truncateUtf8("hello", 10).truncated).toBe(false);
    expect(truncateUtf8("hello world", 5).truncated).toBe(true);
  });
});

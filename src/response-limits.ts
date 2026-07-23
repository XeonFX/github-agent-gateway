import { AppError } from "./errors";

export type ResponseLimitKind = "upstream" | "action";

function announcedLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function limitError(kind: ResponseLimitKind, maxBytes: number, announcedBytes?: number, actualBytes?: number): AppError {
  const upstream = kind === "upstream";
  return new AppError(
    upstream
      ? "GitHub response exceeds the gateway processing limit"
      : "Gateway response exceeds the action response limit",
    413,
    upstream ? "upstream_response_too_large" : "response_too_large",
    {
      announcedBytes,
      actualBytes,
      maxBytes,
      suggestedCalls: [
        "Use a summary or compact view",
        "Set includePatch=false",
        "Lower the requested page size",
        "Continue from the returned cursor"
      ]
    }
  );
}

async function readBoundedBytes(response: Response, maxBytes: number, kind: ResponseLimitKind): Promise<Uint8Array> {
  const announcedBytes = announcedLength(response);
  if (announcedBytes !== undefined && announcedBytes > maxBytes) {
    throw limitError(kind, maxBytes, announcedBytes);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw limitError(kind, maxBytes, announcedBytes, bytes.byteLength);
  }
  return bytes;
}

export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(response, maxBytes, "upstream"));
}

export async function assertResponseWithinLimit(response: Response, maxBytes: number): Promise<void> {
  if (!response.body) return;
  await readBoundedBytes(response.clone(), maxBytes, "action");
}

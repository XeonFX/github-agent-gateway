export class AppError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "bad_request",
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class GitHubApiError extends AppError {
  constructor(
    message: string,
    status: number,
    public readonly githubRequestId?: string,
    details?: unknown
  ) {
    super(message, status, "github_api_error", details);
    this.name = "GitHubApiError";
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof AppError && error.status === 404;
}

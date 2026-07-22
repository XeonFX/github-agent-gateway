import type { Env, GitHubErrorBody, GitHubRequestOptions } from "../types";
import { GitHubApiError, AppError } from "../errors";
import { createGitHubAppJwt } from "./jwt";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const installationCache = new Map<string, number>();
const tokenCache = new Map<number, CachedToken>();

export class GitHubClient {
  constructor(private readonly env: Env) {}

  async request<T>(method: string, path: string, options: GitHubRequestOptions = {}): Promise<T> {
    const url = new URL(path.startsWith("http") ? path : `${API_ROOT}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const auth = options.auth ?? "installation";
    let token: string;
    if (auth === "app") {
      token = createGitHubAppJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_PRIVATE_KEY_BASE64);
    } else {
      if (!options.owner || !options.repository) {
        throw new AppError("owner and repository are required for installation authentication", 500, "internal_error");
      }
      token = await this.getInstallationToken(options.owner, options.repository);
    }

    const response = await fetch(url, {
      method,
      redirect: options.redirect ?? "follow",
      headers: {
        Accept: options.accept ?? "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "github-agent-gateway/1.0",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });

    if (!response.ok) {
      const text = await response.text();
      let details: GitHubErrorBody | string = text;
      try { details = JSON.parse(text) as GitHubErrorBody; } catch { /* keep text */ }
      const message = typeof details === "object" && details?.message
        ? details.message
        : `GitHub API request failed with status ${response.status}`;
      throw new GitHubApiError(message, response.status, response.headers.get("x-github-request-id") ?? undefined, details);
    }

    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) return await response.json() as T;
    return await response.text() as T;
  }

  async requestResponse(method: string, path: string, options: GitHubRequestOptions = {}): Promise<Response> {
    const url = new URL(`${API_ROOT}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    if (!options.owner || !options.repository) {
      throw new AppError("owner and repository are required", 500, "internal_error");
    }
    const token = await this.getInstallationToken(options.owner, options.repository);
    return fetch(url, {
      method,
      redirect: options.redirect ?? "manual",
      headers: {
        Accept: options.accept ?? "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "github-agent-gateway/1.0"
      }
    });
  }

  private async getInstallationId(owner: string, repository: string): Promise<number> {
    if (this.env.GITHUB_INSTALLATION_ID?.trim()) {
      const value = Number.parseInt(this.env.GITHUB_INSTALLATION_ID, 10);
      if (!Number.isFinite(value)) throw new AppError("GITHUB_INSTALLATION_ID must be numeric", 500, "configuration_error");
      return value;
    }

    const cacheKey = `${owner}/${repository}`.toLowerCase();
    const cached = installationCache.get(cacheKey);
    if (cached) return cached;

    const installation = await this.request<{ id: number }>(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/installation`,
      { auth: "app" }
    );
    installationCache.set(cacheKey, installation.id);
    return installation.id;
  }

  private async getInstallationToken(owner: string, repository: string): Promise<string> {
    const installationId = await this.getInstallationId(owner, repository);
    const cached = tokenCache.get(installationId);
    if (cached && cached.expiresAtMs > Date.now() + 60_000) return cached.token;

    const tokenData = await this.request<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      { auth: "app" }
    );
    tokenCache.set(installationId, {
      token: tokenData.token,
      expiresAtMs: new Date(tokenData.expires_at).getTime()
    });
    return tokenData.token;
  }
}

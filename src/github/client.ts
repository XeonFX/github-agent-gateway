import type { Env, GitHubErrorBody, GitHubRequestOptions } from "../types";
import { GitHubApiError, AppError } from "../errors";
import { createGitHubAppJwt } from "./jwt";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "github-agent-gateway/1.2";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const ACCESS_CACHE_MS = 30_000;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

interface CachedInstallation {
  installationId: number;
  expiresAtMs: number;
}

interface CachedRepositories {
  repositories: InstallationRepository[];
  expiresAtMs: number;
}

interface GitHubInstallation {
  id: number;
  suspended_at?: string | null;
}

interface InstallationRepositoriesResponse {
  total_count: number;
  repositories: InstallationRepository[];
}

export interface InstallationRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string | null;
  owner: { login: string };
  [key: string]: unknown;
}

const installationCache = new Map<string, CachedInstallation>();
const tokenCache = new Map<number, CachedToken>();
const repositoryCache = new Map<number, CachedRepositories>();

export class GitHubClient {
  constructor(private readonly env: Env) {}

  async request<T>(method: string, path: string, options: GitHubRequestOptions = {}): Promise<T> {
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

    return this.requestWithToken<T>(method, path, token, options);
  }

  async requestResponse(method: string, path: string, options: GitHubRequestOptions = {}): Promise<Response> {
    const url = this.createUrl(path, options.query);
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
        "User-Agent": USER_AGENT
      }
    });
  }

  async listInstallationRepositories(): Promise<InstallationRepository[]> {
    const installationIds = await this.getInstallationIds();
    const repositories = new Map<number, InstallationRepository>();

    for (const installationId of installationIds) {
      for (const repository of await this.getRepositoriesForInstallation(installationId)) {
        repositories.set(repository.id, repository);
        installationCache.set(repository.full_name.toLowerCase(), {
          installationId,
          expiresAtMs: Date.now() + ACCESS_CACHE_MS
        });
      }
    }

    return [...repositories.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
  }

  private createUrl(path: string, query: GitHubRequestOptions["query"]): URL {
    const url = new URL(path.startsWith("http") ? path : `${API_ROOT}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async requestWithToken<T>(
    method: string,
    path: string,
    token: string,
    options: GitHubRequestOptions = {}
  ): Promise<T> {
    const response = await fetch(this.createUrl(path, options.query), {
      method,
      redirect: options.redirect ?? "follow",
      headers: {
        Accept: options.accept ?? "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": USER_AGENT,
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
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

  private configuredInstallationId(): number | undefined {
    const raw = this.env.GITHUB_INSTALLATION_ID?.trim();
    if (!raw) return undefined;

    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== raw) {
      throw new AppError("GITHUB_INSTALLATION_ID must be a positive integer", 500, "configuration_error");
    }
    return value;
  }

  private async getInstallationIds(): Promise<number[]> {
    const configured = this.configuredInstallationId();
    if (configured !== undefined) return [configured];

    const installationIds: number[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const installations = await this.request<GitHubInstallation[]>("GET", "/app/installations", {
        auth: "app",
        query: { per_page: PAGE_SIZE, page }
      });
      installationIds.push(...installations.filter((item) => !item.suspended_at).map((item) => item.id));
      if (installations.length < PAGE_SIZE) return installationIds;
    }

    throw new AppError(
      `GitHub App installation discovery exceeded ${MAX_PAGES * PAGE_SIZE} installations; set GITHUB_INSTALLATION_ID`,
      500,
      "configuration_error"
    );
  }

  private async getInstallationId(owner: string, repository: string): Promise<number> {
    const cacheKey = `${owner}/${repository}`.toLowerCase();
    const cached = installationCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) return cached.installationId;

    let installation: { id: number };
    try {
      installation = await this.request<{ id: number }>(
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/installation`,
        { auth: "app" }
      );
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        throw new AppError(
          `Repository ${owner}/${repository} is not accessible through this GitHub App`,
          403,
          "repository_not_accessible"
        );
      }
      throw error;
    }

    const configured = this.configuredInstallationId();
    if (configured !== undefined && installation.id !== configured) {
      throw new AppError(
        `Repository ${owner}/${repository} is not accessible through the configured GitHub App installation`,
        403,
        "repository_not_accessible"
      );
    }

    const repositories = await this.getRepositoriesForInstallation(installation.id);
    const accessible = repositories.some((item) => item.full_name.toLowerCase() === cacheKey);
    if (!accessible) {
      throw new AppError(
        `Repository ${owner}/${repository} is not selected in the GitHub App installation`,
        403,
        "repository_not_accessible"
      );
    }

    installationCache.set(cacheKey, {
      installationId: installation.id,
      expiresAtMs: Date.now() + ACCESS_CACHE_MS
    });
    return installation.id;
  }

  private async getRepositoriesForInstallation(installationId: number): Promise<InstallationRepository[]> {
    const cached = repositoryCache.get(installationId);
    if (cached && cached.expiresAtMs > Date.now()) return cached.repositories;

    const token = await this.getInstallationTokenById(installationId);
    const repositories: InstallationRepository[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.requestWithToken<InstallationRepositoriesResponse>(
        "GET",
        "/installation/repositories",
        token,
        { query: { per_page: PAGE_SIZE, page } }
      );
      repositories.push(...result.repositories);
      if (result.repositories.length < PAGE_SIZE) {
        repositoryCache.set(installationId, {
          repositories,
          expiresAtMs: Date.now() + ACCESS_CACHE_MS
        });
        return repositories;
      }
    }

    throw new AppError(
      `GitHub App installation ${installationId} exposes more than ${MAX_PAGES * PAGE_SIZE} repositories`,
      500,
      "configuration_error"
    );
  }

  private async getInstallationToken(owner: string, repository: string): Promise<string> {
    return this.getInstallationTokenById(await this.getInstallationId(owner, repository));
  }

  private async getInstallationTokenById(installationId: number): Promise<string> {
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

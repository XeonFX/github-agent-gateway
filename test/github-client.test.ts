import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("../src/github/jwt", () => ({
  createGitHubAppJwt: () => "app-jwt"
}));

import { GitHubClient } from "../src/github/client";

const baseEnv = {
  GITHUB_APP_ID: "123456",
  GITHUB_PRIVATE_KEY_BASE64: "unused-in-test"
} as Env;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("GitHub installation repository discovery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lists repositories selected for a fixed installation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        token: "installation-token",
        expires_at: "2099-01-01T00:00:00Z"
      }))
      .mockResolvedValueOnce(jsonResponse({
        total_count: 1,
        repositories: [{
          id: 1,
          name: "gateway",
          full_name: "octo/gateway",
          private: true,
          html_url: "https://github.com/octo/gateway",
          default_branch: "main",
          owner: { login: "octo" }
        }]
      }));
    vi.stubGlobal("fetch", fetchMock);

    const repositories = await new GitHubClient({
      ...baseEnv,
      GITHUB_INSTALLATION_ID: "42"
    }).listInstallationRepositories();

    expect(repositories.map((repository) => repository.full_name)).toEqual(["octo/gateway"]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pathname: "/app/installations/42/access_tokens" }),
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pathname: "/installation/repositories" }),
      expect.objectContaining({ method: "GET" })
    );
  });

  it("discovers all active app installations when no installation ID is configured", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 84, suspended_at: null }]))
      .mockResolvedValueOnce(jsonResponse({
        token: "installation-token-two",
        expires_at: "2099-01-01T00:00:00Z"
      }))
      .mockResolvedValueOnce(jsonResponse({
        total_count: 1,
        repositories: [{
          id: 2,
          name: "gateway-two",
          full_name: "octo/gateway-two",
          private: false,
          html_url: "https://github.com/octo/gateway-two",
          default_branch: "main",
          owner: { login: "octo" }
        }]
      }));
    vi.stubGlobal("fetch", fetchMock);

    const repositories = await new GitHubClient(baseEnv).listInstallationRepositories();

    expect(repositories.map((repository) => repository.full_name)).toEqual(["octo/gateway-two"]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pathname: "/app/installations" }),
      expect.objectContaining({ method: "GET" })
    );
  });

  it("rejects a repository belonging to a different configured installation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ id: 99 })));

    const client = new GitHubClient({
      ...baseEnv,
      GITHUB_INSTALLATION_ID: "42"
    });

    await expect(client.request(
      "GET",
      "/repos/octo/not-selected",
      { owner: "octo", repository: "not-selected" }
    )).rejects.toMatchObject({
      status: 403,
      code: "repository_not_accessible"
    });
  });

  it("rejects a repository that is not selected in the resolved installation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 126 }))
      .mockResolvedValueOnce(jsonResponse({
        token: "installation-token-three",
        expires_at: "2099-01-01T00:00:00Z"
      }))
      .mockResolvedValueOnce(jsonResponse({
        total_count: 1,
        repositories: [{
          id: 3,
          name: "selected",
          full_name: "octo/selected",
          private: true,
          html_url: "https://github.com/octo/selected",
          default_branch: "main",
          owner: { login: "octo" }
        }]
      }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient(baseEnv);

    await expect(client.request(
      "GET",
      "/repos/octo/not-selected",
      { owner: "octo", repository: "not-selected" }
    )).rejects.toMatchObject({
      status: 403,
      code: "repository_not_accessible"
    });
  });

  it("does not expose GitHub's public repository fallback when the app is not installed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404)));

    const client = new GitHubClient(baseEnv);

    await expect(client.request(
      "GET",
      "/repos/public-owner/public-repo",
      { owner: "public-owner", repository: "public-repo" }
    )).rejects.toMatchObject({
      status: 403,
      code: "repository_not_accessible"
    });
  });
});

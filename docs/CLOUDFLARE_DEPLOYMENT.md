# Cloudflare deployment: step by step

This guide deploys GitHub Agent Gateway from the `XeonFX/github-agent-gateway` repository using Cloudflare Workers Builds.

The gateway is vendor-neutral. ChatGPT Custom Actions are one supported client; any Bearer-authenticated HTTP/OpenAPI client can use it.

## 1. Apply and push the branch-policy update

Apply the supplied patch from the repository root:

```bash
git apply github-agent-gateway-universal-branches.patch
npm install
npm run check
git add .
git commit -m "feat: make branch policy vendor-neutral and configurable"
git push origin main
```

The recommended personal configuration in `wrangler.jsonc` is:

```jsonc
"BRANCH_WRITE_POLICY": "unrestricted",
"WRITABLE_BRANCH_PREFIXES": "agent/",
"PROTECTED_BRANCHES": "main,master,develop,development,production,release"
```

This permits clients to choose names such as `feature/...`, `fix/...`, `refactor/...`, or `agent/...`, while the gateway still rejects the configured protected branches and the repository's actual default branch.

## 2. Create the GitHub App

Open **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.

Use these values:

| Field | Value |
|---|---|
| Name | `XeonFX Repository Agent` or another unique name |
| Description | `Secure GitHub management gateway for AI agents and automation clients.` |
| Homepage URL | `https://github.com/XeonFX/github-agent-gateway` initially |
| Callback URL | Empty |
| Setup URL | Empty |
| Webhook | Inactive |
| Installation scope | Only on this account |

Repository permissions for the initial deployment:

| Permission | Access |
|---|---|
| Metadata | Read-only, automatically included |
| Contents | Read and write |
| Pull requests | Read and write |
| Issues | Read and write |
| Actions | Read and write |
| Workflows | No access initially |
| Administration | No access initially |

After creation:

1. Copy the numeric **App ID**.
2. Generate and download a private key (`.pem`).
3. Select **Install App**.
4. Install it on **Only select repositories**.
5. Select `Peerly`, `HeyHubs`, and `github-agent-gateway` if the gateway should manage itself.

Do not commit the PEM file.

## 3. Create the D1 database

From the repository directory:

```bash
npm install
npx wrangler login
npm run db:create
```

Copy the returned database ID into `wrangler.jsonc`:

```jsonc
"database_id": "YOUR-REAL-D1-UUID"
```

Commit and push that change:

```bash
git add wrangler.jsonc package-lock.json
git commit -m "chore: configure Cloudflare D1 database"
git push origin main
```

Apply the schema to the remote database:

```bash
npm run db:migrate:remote
```

## 4. Connect the GitHub repository in Cloudflare

In Cloudflare, open **Workers & Pages → Create → Import a repository** and select `XeonFX/github-agent-gateway`.

Use:

| Setting | Value |
|---|---|
| Worker name | `github-agent-gateway` |
| Production branch | `main` |
| Root directory | `/` or leave empty |
| Build command | `npm run check` |
| Deploy command | `npm run deploy` |
| Non-production deploy command | `npx wrangler versions upload` |

No additional command parameters are needed.

If you want the first deployment to be as simple as possible, the build command may be left empty. Wrangler bundles TypeScript during deployment. `npm run check` is recommended after dependencies and tests pass because it blocks deployment when type checking or tests fail.

The Worker name must match `name` in `wrangler.jsonc`.

## 5. Add runtime secrets

Generate the gateway bearer token:

```bash
openssl rand -base64 48
```

Encode the GitHub App private key on macOS:

```bash
base64 -i /path/to/github-app.pem | tr -d '\n'
```

In Cloudflare, open the deployed Worker and go to **Settings → Variables & Secrets**. Add these as encrypted secrets:

| Secret | Value |
|---|---|
| `ACTION_API_KEY` | The random token generated above |
| `GITHUB_APP_ID` | Numeric GitHub App ID |
| `GITHUB_PRIVATE_KEY_BASE64` | One-line base64 form of the PEM |

`GITHUB_INSTALLATION_ID` is optional because the gateway can resolve the installation per repository.

Do not add these only as Workers Builds variables. Build variables are not runtime bindings.

After adding secrets, deploy the latest version again if Cloudflare does not automatically make them available to the active deployment.

## 6. Verify the Worker

Set local shell variables:

```bash
export BASE_URL="https://github-agent-gateway.YOUR-SUBDOMAIN.workers.dev"
export ACTION_API_KEY="YOUR-GATEWAY-BEARER-TOKEN"
```

Check health:

```bash
curl "$BASE_URL/health"
```

Expected:

```json
{"ok":true,"service":"github-agent-gateway","version":"1.1.0"}
```

Check effective policy:

```bash
curl \
  -H "Authorization: Bearer $ACTION_API_KEY" \
  "$BASE_URL/v1/capabilities"
```

Confirm that it reports:

- `mode: unrestricted`
- `generatedPrefix: agent/`
- protected branches
- all three intended repositories
- merge, destructive operations, and administration disabled

Check GitHub access:

```bash
curl \
  -H "Authorization: Bearer $ACTION_API_KEY" \
  "$BASE_URL/v1/repositories"
```

If a repository returns an error, verify both `ALLOWED_REPOSITORIES` and the GitHub App installation repository selection.

## 7. Test a harmless branch

Create a temporary branch:

```bash
curl -X POST \
  -H "Authorization: Bearer $ACTION_API_KEY" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/repos/XeonFX/github-agent-gateway/branches" \
  -d '{
    "name": "test/gateway-smoke-test",
    "fromRef": "main"
  }'
```

This demonstrates unrestricted naming. A request using `main` as the new or writable target must be rejected.

Branch deletion remains disabled while `ENABLE_DESTRUCTIVE_OPERATIONS=false`, so delete this temporary branch manually in GitHub or temporarily enable deletion only after testing the confirmation flow.

## 8. Add the validation workflow to managed repositories

Copy:

```text
examples/managed-repository-agent-validation.yml
```

to each managed repository as:

```text
.github/workflows/agent-validation.yml
```

Adapt the install, build, test, lint, and E2E commands to each repository. Keep its `GITHUB_TOKEN` permissions minimal.

The gateway may dispatch only workflow files listed in `ALLOWED_WORKFLOWS`.

## 9. Connect ChatGPT

Open the GPT editor and create or edit a private GPT:

1. Open **Configure → Actions → Create new action**.
2. Import `https://YOUR-WORKER/openapi.json`.
3. Choose API-key authentication.
4. Choose Bearer authentication.
5. Enter the same value as `ACTION_API_KEY`.
6. Paste `examples/custom-gpt-instructions.md` into the GPT instructions.
7. In Preview, first ask it to list capabilities and repositories.
8. Keep the GPT private until read, preview, apply, workflow, and PR operations are tested.

A GPT action requires an OpenAPI schema and an authentication configuration. The same Worker can simultaneously be called by other HTTP clients using the same contract.

## 10. Recommended first production test

Use the gateway repository itself:

1. Ask the client to read `README.md`.
2. Ask it to create a change plan that fixes a harmless typo.
3. Verify the diff and explicitly approve it.
4. Apply the plan to a new `test/...` or `docs/...` branch.
5. Create a draft pull request.
6. Run the allowlisted validation workflow.
7. Review and merge manually in GitHub.

Do not enable merge, destructive, workflow-file changes, or administration until this complete flow works correctly.

## 11. Later hardening

After the smoke test:

- Enable a GitHub ruleset for `main` requiring pull requests and CI.
- Rotate `ACTION_API_KEY` if it was ever pasted into logs or screenshots.
- Keep `Administration` and `Workflows` GitHub App permissions disabled until needed.
- Consider separate API keys or a reverse proxy if multiple unrelated agents will use the deployment.
- Review D1 audit entries periodically.

## Official references

- Cloudflare Workers Builds: https://developers.cloudflare.com/workers/ci-cd/builds/
- Workers Builds configuration: https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- Cloudflare Worker secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- D1 migrations: https://developers.cloudflare.com/d1/reference/migrations/
- GitHub App registration: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
- GitHub App permissions: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- ChatGPT Actions: https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts

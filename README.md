# GitHub Agent Gateway

A deployable **Cloudflare Worker** that gives a ChatGPT Custom Action controlled access to GitHub repositories through a GitHub App.

It can read repositories, preview and apply atomic multi-file commits, create and manage pull requests, inspect and dispatch allowlisted GitHub Actions workflows, manage issues and labels, create releases and tags, and optionally perform administrative operations such as branch protection and collaborator management.

The gateway deliberately does **not** expose an arbitrary shell or unrestricted GitHub API proxy.

## Highlights

- Cloudflare Workers + TypeScript + Hono
- GitHub App authentication with one-hour installation tokens
- Exact repository allowlist
- Immutable D1-backed change plans
- Unified diff preview before every code-writing operation
- Atomic multi-file commits using Git blobs, trees, commits and refs
- Base-SHA optimistic concurrency protection
- Mandatory `chatgpt/` branch prefix
- Draft pull requests by default
- Allowlisted workflow dispatch instead of arbitrary command execution
- D1 audit log and idempotency support
- Sensitive-file and workflow-file policy checks
- Destructive, merge and administration features disabled by default
- Dynamic OpenAPI document at `/openapi.json`

## What is supported

| Area | Operations |
|---|---|
| Repository | List allowlisted repositories, metadata, contents, recursive tree, settings update when enabled |
| Git | Branch list/create/delete, safe follow-up commits, commit list/read, ref comparison, tags |
| Code changes | Immutable preview, textual/binary change summary, atomic commit, stale-plan protection |
| Pull requests | List, read, create, edit, comment, reviewers, reviews, optional merge |
| Issues | List, read, create, edit, close/reopen, comment, assignees, labels, milestones |
| Labels | List, create, edit, optional delete |
| Actions | List workflows/runs/jobs, dispatch allowlisted workflows, temporary logs URL, rerun/cancel |
| Releases | List, latest, read, create, edit, optional delete |
| Administration | Optional repository settings, branch protection and collaborators |

Not implemented intentionally: repository secrets, environment secrets, deploy keys, arbitrary command execution, arbitrary REST proxying, organization administration and repository deletion.

## Architecture

```text
ChatGPT Custom GPT
        |
        | HTTPS + Bearer API key
        v
Cloudflare Worker
        |-- repository/path/branch policies
        |-- GitHub App JWT + installation token
        |-- D1 change plans and audit log
        |-- OpenAPI action endpoints
        |
        +----------> GitHub REST API
                         |
                         +--> commits / branches / PRs / issues / releases
                         +--> GitHub Actions for builds and tests
```

The Worker never runs `npm install`, `dotnet build`, Playwright or shell commands. Builds and tests run in GitHub Actions.

## Prerequisites

- Node.js 20 or newer
- A Cloudflare account
- A GitHub account with permission to create a GitHub App
- A ChatGPT plan that supports creating Custom GPTs and Actions

## 1. Create the GitHub App

Open GitHub:

1. **Settings**
2. **Developer settings**
3. **GitHub Apps**
4. **New GitHub App**

Suggested values:

| Field | Value |
|---|---|
| GitHub App name | `YourName ChatGPT Repository Agent` |
| Homepage URL | Your Worker URL later, or a placeholder HTTPS URL |
| Callback URL | Leave empty |
| Webhook | Disable for the initial version |
| Where can this GitHub App be installed? | Only on this account, unless you need organizations |

### Repository permissions

Enable only the permissions you need:

| Permission | Level | Required for |
|---|---:|---|
| Metadata | Read | Automatically included |
| Contents | Read and write | Files, trees, branches, commits and tags |
| Pull requests | Read and write | PR creation, updates, reviews and merge |
| Issues | Read and write | Issues, PR conversation comments and labels |
| Actions | Read and write | Read runs, dispatch, rerun and cancel workflows |
| Workflows | Read and write | Only when allowing changes under `.github/workflows` |
| Administration | Read and write | Optional repository settings, protection and collaborators |

Recommended first deployment:

- Enable **Contents**, **Pull requests**, **Issues** and **Actions**.
- Leave **Workflows** and **Administration** disabled.
- Keep `ENABLE_MERGE`, `ENABLE_DESTRUCTIVE_OPERATIONS` and `ENABLE_ADMIN_OPERATIONS` set to `false`.

After creating the app:

1. Note its numeric **App ID**. This is not the Client ID.
2. Generate a private key and download the `.pem` file.
3. Install the app.
4. Select **Only select repositories**.
5. Choose the repositories this gateway may manage.

You may optionally note the installation ID from the installation URL. It is safe to omit it because the Worker can resolve the installation from each repository.

## 2. Install the project

```bash
npm install
cp .dev.vars.example .dev.vars
```

Generate a strong Action API key:

```bash
openssl rand -base64 48
```

Encode the GitHub App private key as one base64 line on macOS:

```bash
base64 -i your-github-app.private-key.pem | tr -d '\n'
```

On Linux:

```bash
base64 -w 0 your-github-app.private-key.pem
```

Put the values into `.dev.vars` for local development:

```dotenv
ACTION_API_KEY=your-long-random-secret
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_BASE64=LS0tLS1CRUdJTi...
GITHUB_INSTALLATION_ID=
```

Never commit `.dev.vars` or the private key.

## 3. Create the D1 database

Authenticate Wrangler:

```bash
npx wrangler login
```

Create D1:

```bash
npm run db:create
```

Wrangler prints a database ID. Replace this value in `wrangler.jsonc`:

```jsonc
"database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

Apply the migration locally:

```bash
npm run db:migrate:local
```

Apply it to Cloudflare:

```bash
npm run db:migrate:remote
```

## 4. Configure repository policy

Edit the non-secret variables in `wrangler.jsonc`:

```jsonc
"vars": {
  "ALLOWED_REPOSITORIES": "XeonFX/Peerly,XeonFX/HeyHubs",
  "BRANCH_PREFIX": "chatgpt/",
  "PLAN_TTL_MINUTES": "30",
  "MAX_PLAN_FILES": "12",
  "MAX_PLAN_BYTES": "524288",
  "MAX_DIFF_BYTES": "196608",
  "ENABLE_MERGE": "false",
  "ENABLE_DESTRUCTIVE_OPERATIONS": "false",
  "ENABLE_ADMIN_OPERATIONS": "false",
  "ENABLE_WORKFLOW_WRITE": "true",
  "ENABLE_WORKFLOW_FILE_CHANGES": "false",
  "ALLOWED_WORKFLOWS": "agent-validation.yml"
}
```

### Feature flags

| Variable | Default | Meaning |
|---|---:|---|
| `ENABLE_MERGE` | `false` | Allows the PR merge endpoint |
| `ENABLE_DESTRUCTIVE_OPERATIONS` | `false` | Allows branch/label/release deletion, protection removal and collaborator removal |
| `ENABLE_ADMIN_OPERATIONS` | `false` | Allows repo settings, branch protection and collaborators |
| `ENABLE_WORKFLOW_WRITE` | `true` | Allows workflow dispatch, rerun and cancellation |
| `ENABLE_WORKFLOW_FILE_CHANGES` | `false` | Allows commit plans to modify `.github/workflows/*` |
| `ALLOWED_WORKFLOWS` | empty | Comma-separated workflow filenames/IDs that may be dispatched |

Administrative endpoints also require the GitHub App's **Administration** permission. Workflow file commits require **Workflows** permission.

## 5. Upload production secrets

```bash
npx wrangler secret put ACTION_API_KEY
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_PRIVATE_KEY_BASE64
```

Optional:

```bash
npx wrangler secret put GITHUB_INSTALLATION_ID
```

Paste the raw values when Wrangler prompts. For `GITHUB_PRIVATE_KEY_BASE64`, paste the one-line base64 value, not the PEM itself.

## 6. Test locally

```bash
npm run dev
```

Public health endpoint:

```bash
curl http://localhost:8787/health
```

Authenticated repository list:

```bash
curl \
  -H "Authorization: Bearer YOUR_ACTION_API_KEY" \
  http://localhost:8787/v1/repositories
```

Run project checks:

```bash
npm run check
```

Commit the generated `package-lock.json` after the first successful `npm install`; the included CI workflow will then be fully reproducible if you switch its install step to `npm ci`.

## 7. Deploy

```bash
npm run deploy
```

Wrangler returns a URL similar to:

```text
https://github-agent-gateway.your-subdomain.workers.dev
```

Verify it:

```bash
BASE_URL="https://github-agent-gateway.your-subdomain.workers.dev" \
ACTION_API_KEY="your-secret" \
./examples/action-test.sh
```

## 8. Add validation workflow to managed repositories

Copy `examples/managed-repository-agent-validation.yml` into each managed repository as:

```text
.github/workflows/agent-validation.yml
```

Adapt the commands to the repository. For a .NET repository, for example:

```yaml
- uses: actions/setup-dotnet@v4
  with:
    dotnet-version: 9.0.x

- if: inputs.preset == 'build'
  run: dotnet build --configuration Release

- if: inputs.preset == 'test'
  run: dotnet test --configuration Release --no-restore
```

Keep workflow permissions minimal. Do not expose production secrets to validation jobs triggered for agent-created branches unless absolutely necessary.

## 9. Configure the Custom GPT Action

1. Open the GPT builder.
2. Create or edit your private Custom GPT.
3. Open **Configure** → **Actions**.
4. Import the schema from:

```text
https://github-agent-gateway.your-subdomain.workers.dev/openapi.json
```

5. Configure authentication as **API key**.
6. Use **Bearer** authentication.
7. Enter the same value stored in `ACTION_API_KEY`.
8. Paste the contents of `examples/custom-gpt-instructions.md` into the GPT instructions.
9. Keep the GPT private while testing.

The `/openapi.json` response automatically uses the Worker request origin, so you do not need to edit the server URL after deployment.

## Safe code-change workflow

### Preview

```bash
curl -X POST "$BASE_URL/v1/change-plans" \
  -H "Authorization: Bearer $ACTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "owner": "XeonFX",
    "repository": "Peerly",
    "baseBranch": "main",
    "commitMessage": "fix: stabilize attachment synchronization",
    "files": [
      {
        "path": "src/attachments.ts",
        "operation": "update",
        "contentEncoding": "utf-8",
        "content": "complete replacement file content"
      }
    ]
  }'
```

The response contains:

- `id`
- `baseSha`
- `proposedBranch`
- textual `diff`
- warnings
- an exact confirmation phrase
- expiration time

No GitHub write occurs during preview.

### Apply

```bash
curl -X POST "$BASE_URL/v1/change-plans/PLAN_ID/apply" \
  -H "Authorization: Bearer $ACTION_API_KEY" \
  -H "Idempotency-Key: a-unique-client-generated-key" \
  -H "Content-Type: application/json" \
  -d '{
    "expectedBaseSha": "SHA_FROM_PREVIEW",
    "confirmation": "APPLY XeonFX/Peerly chatgpt/fix-stabilize-attachments-20260722-abc123"
  }'
```

The Worker verifies that:

- the plan still exists and has not expired;
- the content is exactly what was previewed;
- the base SHA is unchanged;
- the target branch does not already exist;
- all paths still satisfy policy;
- the branch uses the configured prefix.

It then creates blobs, one tree and one commit. For a new branch it creates a branch ref; for a follow-up commit it advances an existing `chatgpt/` branch without force-pushing.

### Add a follow-up commit to an existing PR branch

Create another change plan with `baseBranch` and `proposedBranch` set to the same existing agent branch:

```json
{
  "baseBranch": "chatgpt/fix-attachment-sync",
  "proposedBranch": "chatgpt/fix-attachment-sync"
}
```

The preview records the branch head SHA. Apply fails if the branch moves before the commit is written.

## Exact confirmation phrases

Potentially harmful operations require exact phrases:

| Operation | Phrase |
|---|---|
| Apply plan | `APPLY owner/repository branch` |
| Merge PR | `MERGE owner/repository#number` |
| Delete branch | `DELETE BRANCH owner/repository branch` |
| Delete label | `DELETE LABEL owner/repository label` |
| Delete release | `DELETE RELEASE owner/repository releaseId` |
| Delete tag | `DELETE TAG owner/repository tag` |
| Rerun workflow | `RERUN owner/repository runId` |
| Cancel workflow | `CANCEL owner/repository runId` |
| Update repository | `UPDATE owner/repository` |
| Set protection | `PROTECT owner/repository branch` |
| Remove protection | `UNPROTECT owner/repository branch` |
| Add collaborator | `INVITE username TO owner/repository AS permission` |
| Remove collaborator | `REMOVE username FROM owner/repository` |

These phrases are not a substitute for user approval; they make accidental or malformed calls less likely.

## API surface

The complete Custom Action schema is in `openapi.action.json` and is served dynamically at `/openapi.json`.

Main route groups:

```text
GET/PATCH /v1/repos/{owner}/{repository}
GET       /v1/repos/{owner}/{repository}/contents
GET       /v1/repos/{owner}/{repository}/tree
GET/POST  /v1/repos/{owner}/{repository}/branches
GET       /v1/repos/{owner}/{repository}/commits
GET       /v1/repos/{owner}/{repository}/compare
POST/GET  /v1/change-plans
POST      /v1/change-plans/{id}/apply
GET/POST/PATCH /v1/repos/{owner}/{repository}/pulls
GET/POST/PATCH /v1/repos/{owner}/{repository}/issues
GET/POST/PATCH/DELETE /v1/repos/{owner}/{repository}/labels
GET/POST  /v1/repos/{owner}/{repository}/actions/*
GET/POST/PATCH/DELETE /v1/repos/{owner}/{repository}/releases
GET/POST/DELETE /v1/repos/{owner}/{repository}/tags
GET/PUT/DELETE /v1/repos/{owner}/{repository}/branches/{branch}/protection
GET/PUT/DELETE /v1/repos/{owner}/{repository}/collaborators
```

## Security model

### Repository allowlist

Every repository route calls the server-side allowlist. A model cannot access a repository just by changing action arguments.

### GitHub App installation scope

Install the app only on selected repositories. The GitHub App installation scope is a second independent boundary in addition to `ALLOWED_REPOSITORIES`.

### No long-lived GitHub personal token

The Worker signs a short-lived GitHub App JWT, exchanges it for an installation token and caches that token only in Worker memory until shortly before expiration.

### No arbitrary shell

The Action can dispatch only workflows named in `ALLOWED_WORKFLOWS`. The workflow file defines the actual commands.

### Protected code-writing flow

The action cannot directly submit a generic file-write request. Code changes must pass through preview and apply.

### Sensitive paths

By default the gateway blocks:

- `.env` and `.env.*`
- common private key formats and filenames
- `.github/workflows/*`

Extend `assertSafePath` in `src/policy.ts` for your own repository conventions.

### Cloudflare secrets

Production credentials belong in Worker Secrets, never in `wrangler.jsonc`.

### Audit log

Every meaningful write records:

- request ID
- timestamp
- actor header
- operation
- repository and target
- success metadata

Inspect it with:

```bash
npx wrangler d1 execute github-agent-gateway --remote \
  --command "SELECT * FROM audit_log ORDER BY occurred_at DESC LIMIT 50"
```

## Troubleshooting

### `401 Invalid or missing bearer token`

The Custom GPT API key and Cloudflare `ACTION_API_KEY` secret do not match, or authentication was configured with the wrong header style. Use Bearer authentication.

### `404 Not Found` from GitHub installation lookup

The GitHub App is not installed on that repository, or the repository name in `ALLOWED_REPOSITORIES` is wrong.

### `403 Resource not accessible by integration`

The GitHub App lacks the required repository permission. Update the app permissions, then approve the changed permissions on the installation page.

### Workflow dispatch returns `workflow_not_allowed`

Add the workflow filename or numeric ID to `ALLOWED_WORKFLOWS`, separated by commas, and redeploy.

### Applying a plan returns `stale_change_plan`

The base branch changed after preview. Create a new plan and review the new diff.

### Applying a plan returns `branch_exists`

Use a new proposed branch name or omit `proposedBranch` and let the gateway generate one.

### Workflow file update is blocked

You need all three:

1. GitHub App **Workflows: read and write** permission.
2. `ENABLE_WORKFLOW_FILE_CHANGES=true`.
3. Explicit user approval of a preview containing the workflow change.

### Admin endpoint is disabled

Set `ENABLE_ADMIN_OPERATIONS=true`, grant the GitHub App **Administration** permission, approve the permission change on the installation, and redeploy.

## Development notes

- The GitHub REST API version header is centralized in `src/github/client.ts`.
- The gateway uses complete replacement file contents in change plans. This is simpler and more deterministic than accepting model-generated patch commands.
- Textual diffs are capped by `MAX_DIFF_BYTES`.
- Change plans are capped by file count and total proposed bytes to stay compatible with Cloudflare Worker limits.
- Binary files use base64 input and receive a size-only preview.
- Existing executable-file modes are preserved when GitHub's recursive tree response contains the file.
- The API rejects plans when GitHub reports a truncated tree and an existing path cannot be resolved safely.

## Production checklist

- [ ] GitHub App installed only on intended repositories
- [ ] Exact `ALLOWED_REPOSITORIES`
- [ ] Long random `ACTION_API_KEY`
- [ ] Worker secrets configured
- [ ] D1 migrations applied remotely
- [ ] `ENABLE_MERGE=false` initially
- [ ] `ENABLE_DESTRUCTIVE_OPERATIONS=false` initially
- [ ] `ENABLE_ADMIN_OPERATIONS=false` initially
- [ ] Minimal GitHub App permissions
- [ ] Validation workflows have minimal permissions
- [ ] Custom GPT is private
- [ ] Preview/apply workflow tested on a disposable branch
- [ ] Branch protection requires CI before merge

## License

MIT

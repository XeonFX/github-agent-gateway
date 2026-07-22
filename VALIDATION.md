# Validation report

Validation performed for version 1.2.0:

- TypeScript syntax transpilation passed for every file under `src/` and `test/`.
- The GitHub installation discovery client and its new tests passed a strict TypeScript check using local interface stubs for Cloudflare, Node and Vitest types.
- Runtime smoke checks passed for:
  - listing repositories from a fixed installation;
  - rejecting a repository routed through a different fixed installation;
  - converting a missing GitHub App installation lookup into `repository_not_accessible` instead of falling back to public repository access.
- The Vitest suite now covers fixed-installation discovery, all-installation discovery, selected-repository membership, fixed-installation mismatch and missing-installation rejection.
- `openapi.action.json` contains 56 operations with 56 unique `operationId` values.
- `package.json` and `openapi.action.json` parse successfully.
- No D1 migration is required for this change.
- The patch was generated from the current `feat/branchprotection` tree and verified with `git apply --check` against a clean copy of that baseline.

## Check not completed in the generation environment

The npm package registry was unreachable from the generation container: `npm install` timed out. Therefore the real dependency-backed `npm run check` command and Vitest suite were not executed here.

Run these commands after applying the patch:

```bash
npm install
npm run check
```

Commit the generated `package-lock.json` after a successful install. Once a lockfile exists, changing the CI workflow install step from `npm install` to `npm ci` is recommended.

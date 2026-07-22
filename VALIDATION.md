# Validation report

Validation performed for version 1.1.0:

- TypeScript source type-checked against local interface stubs for Hono, Zod, Cloudflare D1, Node crypto and Vitest.
- The new branch policy was executed in a runtime smoke test covering prefixed mode, unrestricted mode, protected branches and default-branch blocking.
- All 56 authenticated HTTP operations match the operations in `openapi.action.json`.
- Every OpenAPI path placeholder has a corresponding required path parameter.
- All OpenAPI `operationId` values are unique.
- `package.json`, `tsconfig.json`, `wrangler.jsonc` and `openapi.action.json` parse successfully.
- The D1 migration executes successfully in an empty SQLite database.
- Both GitHub Actions workflow files parse successfully as YAML.
- The detailed Cloudflare deployment guide and vendor-neutral client instructions are included.

## Check not completed in the generation environment

The npm package registry was unreachable from the generation container: `npm install` timed out. Therefore the real dependency-backed `npm run check` command and Vitest suite were not executed here.

Run these commands after applying the patch:

```bash
npm install
npm run check
```

Commit the generated `package-lock.json` after a successful install. Once a lockfile exists, changing the CI workflow install step from `npm install` to `npm ci` is recommended.

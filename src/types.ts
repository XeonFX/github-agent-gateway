export interface Env {
  DB: D1Database;
  ACTION_API_KEY: string;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY_BASE64: string;
  GITHUB_INSTALLATION_ID?: string;
  ALLOWED_REPOSITORIES: string;
  BRANCH_PREFIX?: string;
  PLAN_TTL_MINUTES?: string;
  MAX_PLAN_FILES?: string;
  MAX_PLAN_BYTES?: string;
  MAX_DIFF_BYTES?: string;
  ENABLE_MERGE?: string;
  ENABLE_DESTRUCTIVE_OPERATIONS?: string;
  ENABLE_ADMIN_OPERATIONS?: string;
  ENABLE_WORKFLOW_WRITE?: string;
  ENABLE_WORKFLOW_FILE_CHANGES?: string;
  ALLOWED_WORKFLOWS?: string;
}

export interface AppVariables {
  requestId: string;
  actor: string;
}

export interface RepositoryRef {
  owner: string;
  repository: string;
}

export interface GitHubRequestOptions {
  owner?: string;
  repository?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  auth?: "app" | "installation";
  redirect?: RequestRedirect;
  accept?: string;
}

export interface GitHubErrorBody {
  message?: string;
  documentation_url?: string;
  errors?: unknown;
}

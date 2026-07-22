CREATE TABLE IF NOT EXISTS change_plans (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repository TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  proposed_branch TEXT NOT NULL,
  commit_message TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  diff_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'expired', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  applied_at TEXT,
  commit_sha TEXT,
  pull_request_number INTEGER,
  failure_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_change_plans_repo_created
  ON change_plans(owner, repository, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_change_plans_status_expires
  ON change_plans(status, expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  operation TEXT NOT NULL,
  owner TEXT,
  repository TEXT,
  target TEXT,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  metadata_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_repo_time
  ON audit_log(owner, repository, occurred_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expiry
  ON idempotency_keys(expires_at);

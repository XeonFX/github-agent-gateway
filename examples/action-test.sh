#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:?Set BASE_URL to the Worker URL}"
ACTION_API_KEY="${ACTION_API_KEY:?Set ACTION_API_KEY}"

curl --fail --silent --show-error \
  -H "Authorization: Bearer ${ACTION_API_KEY}" \
  "${BASE_URL}/v1/repositories" | jq .

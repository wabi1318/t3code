#!/usr/bin/env bash
set -euo pipefail

for attempt in 1 2 3; do
  if gh api --method POST "repos/$GH_REPO/merge-upstream" -f branch=main \
    > "$RUNNER_TEMP/sync-result.json" 2> "$RUNNER_TEMP/sync-error.txt"; then
    if jq -e 'type == "object" and (.message | type == "string") and (.merge_type | type == "string") and (.base_branch | type == "string")' \
      "$RUNNER_TEMP/sync-result.json" > /dev/null 2>&1; then
      echo "result=synced" >> "$GITHUB_OUTPUT"
      jq -r '.message, "Merge type: \(.merge_type)", "Base branch: \(.base_branch)"' \
        "$RUNNER_TEMP/sync-result.json" >> "$GITHUB_STEP_SUMMARY"
      exit 0
    fi
    echo "Incomplete merge response" > "$RUNNER_TEMP/sync-error.txt"
  elif grep -q 'HTTP 409' "$RUNNER_TEMP/sync-error.txt"; then
    cat "$RUNNER_TEMP/sync-error.txt" >&2
    echo "result=conflict" >> "$GITHUB_OUTPUT"
    exit 0
  elif ! grep -Eqi 'unexpected (end of JSON input|EOF)|HTTP 5[0-9][0-9]|connection reset|TLS handshake timeout|i/o timeout' "$RUNNER_TEMP/sync-error.txt"; then
    cat "$RUNNER_TEMP/sync-error.txt" >&2
    echo "::error::Upstream sync failed. No force update was attempted."
    exit 1
  fi
  cat "$RUNNER_TEMP/sync-error.txt" >&2
  if [ "$attempt" -lt 3 ]; then
    echo "::warning::Temporary upstream sync failure (attempt $attempt/3); retrying."
    sleep "$((attempt * 2))"
  fi
done

echo "::error::Upstream sync failed after 3 attempts. No force update was attempted."
exit 1

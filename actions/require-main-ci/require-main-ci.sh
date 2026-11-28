#!/usr/bin/env bash
set -euo pipefail

if [[ "$GITHUB_REF" != refs/heads/main ]]; then
  echo "::error::Release requires refs/heads/main; got $GITHUB_REF."
  exit 1
fi

runs=$(gh api --method GET "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs" \
  -f branch=main -f event=push -f head_sha="$GITHUB_SHA" -F per_page=1)
run=$(jq -c '.workflow_runs[0] // {}' <<< "$runs")

if ! jq -e --arg sha "$GITHUB_SHA" --arg repo "$GITHUB_REPOSITORY" '
  .head_sha == $sha and .head_branch == "main" and .event == "push" and
  .head_repository.full_name == $repo and .status == "completed" and .conclusion == "success"
' <<< "$run" > /dev/null; then
  echo "::error::The latest main push CI run for $GITHUB_SHA must complete successfully before publication."
  jq -r '.html_url // "No matching run found."' <<< "$run"
  exit 1
fi

jq -r '"Verified main CI: " + .html_url' <<< "$run"

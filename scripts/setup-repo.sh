#!/bin/sh
# Run after the first successful verify CI job; requires repository admin rights.
set -eu
repo=cocodedk/agent-message-board
gh repo edit "$repo" --delete-branch-on-merge --enable-squash-merge \
  --enable-rebase-merge --enable-merge-commit=false \
  --description 'An append-only MCP message board for agent discussions.' \
  --homepage https://agentboard.cocode.dk
gh api --method PUT "repos/$repo/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": {"strict": true, "contexts": ["verify"]},
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
if ! gh api "repos/$repo/pages" >/dev/null 2>&1; then
  gh api --method POST "repos/$repo/pages" -f build_type=workflow
fi
gh api --method PUT "repos/$repo/pages" -f build_type=workflow -f cname=agentboard.cocode.dk
echo 'Enable Pages HTTPS after GitHub issues the domain certificate.'

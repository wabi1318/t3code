#!/usr/bin/env bash
# Merges upstream main into this fork's main from a dedicated worktree, so the
# checkout you work in is never touched.
#
#   scripts/sync-upstream.sh prepare            fetch and merge in .t3/upstream-sync
#                                               exit 0 merged cleanly, 2 conflicts left in the worktree, 3 up to date
#   scripts/sync-upstream.sh verify             install and run check:changed against upstream/main
#   scripts/sync-upstream.sh publish [body.md]  push, open a PR into main, merge it, close the sync issue
#   scripts/sync-upstream.sh auto               all of the above, with Codex resolving conflicts and failures
#   scripts/sync-upstream.sh install|uninstall  run `auto` from launchd daily at 17:15 (macOS)
#
# The upstream-sync skill (.agents/skills/upstream-sync) holds the conflict resolution policy.
set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-pingdotgg/t3code}"
SYNC_MODEL="${SYNC_MODEL:-gpt-6.1-sol}"
SYNC_EFFORT="${SYNC_EFFORT:-high}"
BRANCH="sync/upstream"
ISSUE_LABEL="upstream-sync"
LABEL="com.t3code.upstream-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/t3code-upstream-sync.log"

self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
wt="$root/.t3/upstream-sync"
# Named explicitly: with no default set, gh prefers a remote called "upstream" over origin.
repo="$(gh repo view "$(git -C "$root" remote get-url origin)" --json nameWithOwner --jq .nameWithOwner)"

fail() {
  echo "sync-upstream: $*" >&2
  exit 1
}

fetch() {
  git -C "$root" fetch -q origin main
  git -C "$root" fetch -q "https://github.com/$UPSTREAM_REPO.git" "+main:refs/remotes/upstream/main"
}

prepare() {
  fetch
  local behind
  behind="$(git -C "$root" rev-list --count origin/main..upstream/main)"
  if [ "$behind" = 0 ]; then
    echo "main is up to date with $UPSTREAM_REPO"
    exit 3
  fi
  if [ -e "$wt/.git" ]; then
    git -C "$wt" merge --abort 2>/dev/null || true
    git -C "$wt" reset -q --hard
    git -C "$wt" clean -qfd
    git -C "$wt" checkout -q -B "$BRANCH" origin/main
  else
    git -C "$root" worktree add -q -B "$BRANCH" "$wt" origin/main
  fi
  echo "main is $behind commits behind $UPSTREAM_REPO; merging in $wt"
  if git -C "$wt" merge -q --no-edit -m "Merge upstream main" upstream/main; then
    echo "merged cleanly"
    exit 0
  fi
  echo "conflicts:"
  git -C "$wt" diff --name-only --diff-filter=U
  exit 2
}

require_merged() {
  [ -e "$wt/.git" ] || fail "no worktree at $wt; run prepare first"
  cd "$wt"
  [ -z "$(git status --porcelain)" ] || fail "commit or discard every change in $wt first"
  git merge-base --is-ancestor upstream/main HEAD || fail "HEAD does not contain upstream/main"
  git merge-base --is-ancestor origin/main HEAD || fail "origin/main moved since prepare; run prepare again"
  local forked
  forked="$(git diff --name-only --diff-filter=d upstream/main HEAD)"
  if [ -n "$forked" ] && git grep -nE '^(<<<<<<<|>>>>>>>)( |$)' -- $forked >&2; then
    fail "conflict markers remain"
  fi
}

verify() {
  require_merged
  vp i
  vp run check:changed upstream/main
}

publish() {
  local body="${1:-}"
  [ -z "$body" ] || body="$(cd "$(dirname "$body")" && pwd)/$(basename "$body")"
  # Publish the upstream snapshot we verified; newer upstream commits belong to the next sync.
  git -C "$root" fetch -q origin main
  require_merged
  git push -q --force origin "HEAD:refs/heads/$BRANCH"
  if [ -z "$body" ]; then
    body="$(mktemp)"
    echo "Merges $UPSTREAM_REPO main into main without conflicts." > "$body"
  fi
  local pr
  pr="$(gh pr list --repo "$repo" --head "$BRANCH" --state open --json url --jq '.[0].url // empty')"
  if [ -z "$pr" ]; then
    pr="$(gh pr create --repo "$repo" --base main --head "$BRANCH" \
      --title "chore: merge upstream main" --body-file "$body")"
  else
    gh pr edit "$pr" --repo "$repo" --body-file "$body"
  fi
  gh pr merge "$pr" --repo "$repo" --merge
  for issue in $(gh issue list --repo "$repo" --label "$ISSUE_LABEL" --state open --json number --jq '.[].number'); do
    gh issue close "$issue" --repo "$repo" --comment "Merged in $pr."
  done
  git -C "$root" fetch -q origin main
  echo "merged $pr"
}

# Codex only edits files in the worktree; this script owns every git write, install, and push.
codex_edit() {
  codex exec --cd "$wt" --model "$SYNC_MODEL" -c "model_reasoning_effort=$SYNC_EFFORT" \
    --sandbox workspace-write --ephemeral "$1

Only edit files. Do not run git commands that write (add, commit, checkout, reset, stash,
merge, push) and do not install dependencies; the caller commits, verifies, and publishes.
Read-only commands such as git log, git diff, and package typechecks are fine." </dev/null
}

stop() {
  echo "sync-upstream: $*" >&2
  git -C "$root" rev-parse upstream/main > "$root/.t3/upstream-sync.failed"
  local issue
  issue="$(gh issue list --repo "$repo" --label "$ISSUE_LABEL" --state open --json number --jq '.[0].number // empty')"
  [ -z "$issue" ] || gh issue comment "$issue" --repo "$repo" \
    --body "Automatic sync stopped: $*. The worktree is left at \`$wt\`; see \`$LOG\`." || true
  osascript -e "display notification \"$*\" with title \"T3 Code upstream sync\"" 2>/dev/null || true
  exit 1
}

auto() {
  echo "== upstream sync $(date '+%Y-%m-%d %H:%M:%S')"
  local status=0 body="$wt/.t3/upstream-sync-pr.md" log
  # Separate processes keep `set -e` active inside them.
  "$BASH" "$self" prepare || status=$?
  case "$status" in
    3) return 0 ;;
    0 | 2) ;;
    *) stop "prepare failed" ;;
  esac
  # A failed attempt waits for new upstream commits instead of retrying every run.
  if [ "$(cat "$root/.t3/upstream-sync.failed" 2>/dev/null)" = "$(git -C "$root" rev-parse upstream/main)" ]; then
    echo "skipping: the last attempt on this upstream commit stopped"
    return 0
  fi
  mkdir -p "$wt/.t3"
  rm -f "$body"
  if [ "$status" = 2 ]; then
    codex_edit "You are in a git worktree where $UPSTREAM_REPO main is being merged into this fork's
main, and the merge stopped on conflicts. Follow the \"Resolving conflicts\" section of
.agents/skills/upstream-sync/SKILL.md, with this directory as \$WT. Resolve every file listed
by \`git diff --name-only --diff-filter=U\` so no conflict markers remain. Then write the PR
body described in the skill's \"PR body\" section to $body, ending with
\"Resolved by $SYNC_MODEL ($SYNC_EFFORT) via Codex CLI.\"" || stop "Codex could not resolve the conflicts"
    git -C "$wt" add -A
    git -C "$wt" commit -q --no-verify --no-edit || stop "could not commit the resolution"
  fi
  log="$(mktemp)"
  if ! "$BASH" "$self" verify > "$log" 2>&1; then
    codex_edit "This worktree merges $UPSTREAM_REPO main into this fork, and its verification
(scripts/sync-upstream.sh verify, which runs vp run check:changed upstream/main) failed:

$(tail -n 150 "$log")

Fix the failures the merge caused, following .agents/skills/upstream-sync/SKILL.md. If a failure
also happens on upstream/main itself, leave it and append a note about it to $body." ||
      stop "Codex could not fix verification"
    git -C "$wt" add -A
    git -C "$wt" diff --cached --quiet || git -C "$wt" commit -q --no-verify -m "Fix upstream merge" ||
      stop "could not commit the fix"
    "$BASH" "$self" verify > "$log" 2>&1 || {
      tail -n 50 "$log" >&2
      stop "verification still fails after one fix"
    }
  fi
  if [ -s "$body" ]; then publish "$body"; else publish; fi
}

install() {
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  # Runs origin/main's copy of this script, so the job follows merged changes whatever is checked out.
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>cd "$root" &amp;&amp; git fetch -q origin main &amp;&amp; script="\$(mktemp)" &amp;&amp; git show origin/main:scripts/sync-upstream.sh &gt; "\$script" &amp;&amp; exec /bin/bash "\$script" auto</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATH</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "installed $PLIST; run now with: launchctl kickstart gui/$(id -u)/$LABEL"
}

uninstall() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
}

case "${1:-}" in
  prepare) prepare ;;
  verify) verify ;;
  publish) publish "${2:-}" ;;
  auto) auto ;;
  install) install ;;
  uninstall) uninstall ;;
  *) fail "usage: scripts/sync-upstream.sh prepare|verify|publish [body.md]|auto|install|uninstall" ;;
esac

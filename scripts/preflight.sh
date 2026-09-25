#!/usr/bin/env bash
# agentbox — preflight.sh
# Run before every public post (Reddit, Show HN, Twitter, npm publish).
# Exit 0 = green light. Exit 1 = fix the failures first.
#
# Usage:
#   ./scripts/preflight.sh
#   ./scripts/preflight.sh --quick     # skip slow e2e (demo/wrap)
#   npm run preflight
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

QUICK=0
for arg in "$@"; do
  case "$arg" in
    --quick|-q) QUICK=1 ;;
    --help|-h)
      echo "Usage: $0 [--quick]"
      exit 0
      ;;
  esac
done

PASS=0
FAIL=0
WARN=0
failures=()
warnings=()

GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
DIM='\033[2m'
BOLD='\033[1m'
CYAN='\033[36m'
RESET='\033[0m'

ok()   { PASS=$((PASS + 1)); printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
bad()  { FAIL=$((FAIL + 1)); failures+=("$1"); printf "  ${RED}✗${RESET} %s\n" "$1"; }
warn() { WARN=$((WARN + 1)); warnings+=("$1"); printf "  ${YELLOW}!${RESET} %s\n" "$1"; }
section() { printf "\n${BOLD}${CYAN}▸ %s${RESET}\n" "$1"; }

# ─── 1. Repo shape ──────────────────────────────────────────────────────────
section "Repo shape"

[[ -f package.json ]] && ok "package.json present" || bad "package.json missing"
[[ -f LICENSE ]]      && ok "LICENSE present"      || bad "LICENSE missing"
[[ -f README.md ]]    && ok "README.md present"    || bad "README.md missing"
[[ -f bin/agentbox.js ]] && ok "bin/agentbox.js present" || bad "bin/agentbox.js missing"
[[ -f src/redact.js ]] && ok "src/redact.js present (redaction layer)" || bad "src/redact.js missing"
[[ -f src/chain.js ]]  && ok "src/chain.js present" || bad "src/chain.js missing"
[[ -x bin/agentbox.js || -f bin/agentbox.js ]] && ok "CLI entry exists" || bad "CLI entry missing"

if [[ -f .gitignore ]]; then
  if grep -qE '^\.agentbox/?$|^\.agentbox/' .gitignore || grep -q '\.agentbox' .gitignore; then
    ok ".gitignore mentions .agentbox"
  else
    warn ".gitignore does not ignore .agentbox/ — session tapes could be committed"
  fi
else
  bad ".gitignore missing"
fi

# ─── 2. Identity / placeholders ─────────────────────────────────────────────
section "Identity (no placeholders for public post)"

PKG_NAME=$(node -p "require('./package.json').name" 2>/dev/null || echo "")
PKG_VER=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
PKG_AUTHOR=$(node -p "require('./package.json').author" 2>/dev/null || echo "")
PKG_REPO=$(node -p "require('./package.json').repository && require('./package.json').repository.url" 2>/dev/null || echo "")

[[ -n "$PKG_NAME" ]] && ok "package name: $PKG_NAME" || bad "package name empty"
[[ -n "$PKG_VER" ]]  && ok "package version: $PKG_VER" || bad "package version empty"

CHAIN_VER=$(node -p "require('./src/chain.js').VERSION" 2>/dev/null || echo "")
if [[ -n "$CHAIN_VER" && -n "$PKG_VER" ]]; then
  if [[ "$CHAIN_VER" == "$PKG_VER" ]]; then
    ok "VERSION matches package.json ($PKG_VER)"
  else
    bad "VERSION mismatch: chain.js=$CHAIN_VER package.json=$PKG_VER"
  fi
fi

if echo "$PKG_AUTHOR" | grep -qiE 'you@example\.com|arunsoman|TODO|placeholder'; then
  warn "package.json author still looks like a placeholder: $PKG_AUTHOR"
else
  ok "package.json author set"
fi

if echo "$PKG_REPO" | grep -qiE 'example\.com|TODO'; then
  warn "package.json repository URL still a placeholder: $PKG_REPO"
else
  ok "package.json repository URL set"
fi

PLACEHOLDER_HITS=$(grep -RInE 'example\.com|you@example\.com|TODO' \
  --include='*.md' --include='*.json' --include='*.yml' --include='*.js' \
  README.md package.json action.yml 2>/dev/null | grep -v preflight | head -20 || true)
if [[ -n "$PLACEHOLDER_HITS" ]]; then
  warn "placeholder strings still in published files:"
  while IFS= read -r line; do printf "      ${DIM}%s${RESET}\n" "$line"; done <<< "$PLACEHOLDER_HITS"
else
  ok "no arunsoman/you@example placeholders in core published files"
fi

# ─── 3. Secret scanning (static) ────────────────────────────────────────────
section "Secret-looking literals (GitHub push protection)"

# Continuous token-ish literals that secret scanners flag.
# We allow fragmented construction in tests; we ban continuous forms in tracked source.
SECRET_PATTERNS=(
  'xox[baprs]-[0-9A-Za-z-]{10,}'
  'sk-[A-Za-z0-9]{20,}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'ghp_[A-Za-z0-9]{20,}'
  'sk_live_[A-Za-z0-9]{16,}'
  'sk_test_[A-Za-z0-9]{16,}'
  'AKIA[0-9A-Z]{16}'
  'AIza[0-9A-Za-z_-]{20,}'
)

secret_hits=0
for pat in "${SECRET_PATTERNS[@]}"; do
  # scan source + tests + docs; skip binary, skip node_modules, skip .agentbox sessions
  hits=$(grep -RInE "$pat" \
    --include='*.js' --include='*.md' --include='*.json' --include='*.yml' --include='*.html' \
    src test examples bin README.md CHANGELOG.md package.json action.yml docs 2>/dev/null \
    | grep -v 'node_modules\|\.agentbox\|preflight\.sh' || true)
  if [[ -n "$hits" ]]; then
    secret_hits=$((secret_hits + 1))
    bad "pattern /$pat/ found in source:"
    while IFS= read -r line; do printf "      ${DIM}%s${RESET}\n" "$line"; done <<< "$(echo "$hits" | head -5)"
  fi
done
if [[ $secret_hits -eq 0 ]]; then
  ok "no continuous secret-like literals in source tree"
fi

# ─── 4. Security docs ───────────────────────────────────────────────────────
section "Security documentation"

if grep -qE 'Security & privacy|redact|AGENTBOX_REDACT' README.md; then
  ok "README mentions redaction / security"
else
  bad "README missing Security & privacy / redaction docs"
fi

if grep -q 'AGENTBOX_REDACT' README.md; then
  ok "README documents AGENTBOX_REDACT kill-switch"
else
  warn "README does not document AGENTBOX_REDACT=0"
fi

# ─── 5. Unit / integration tests ────────────────────────────────────────────
section "Test suite"

if npm test >/tmp/agentbox-preflight-tests.log 2>&1; then
  tcount=$(grep -cE '✔|✓' /tmp/agentbox-preflight-tests.log 2>/dev/null || echo 0)
  ok "npm test passed ($tcount checks logged)"
else
  bad "npm test FAILED — see /tmp/agentbox-preflight-tests.log"
  tail -20 /tmp/agentbox-preflight-tests.log | sed 's/^/      /'
fi

# ─── 6. Live smoke (skip with --quick) ──────────────────────────────────────
# Helper: run a command with a hard timeout and stdin from /dev/null so a
# leftover TTY stdin listener can never hang the preflight process.
run_timed() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@" </dev/null
  else
    "$@" </dev/null
  fi
}

if [[ $QUICK -eq 0 ]]; then
  section "Live smoke (demo / wrap / receipt / verify)"
  printf "  ${DIM}(demo takes ~5–6s — agent is intentionally slow)${RESET}\n"

  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT

  # demo
  printf "  ${DIM}→ agentbox demo…${RESET}\n"
  if run_timed 30 node bin/agentbox.js demo >/tmp/agentbox-preflight-demo.log 2>&1; then
    ok "agentbox demo completed"
  else
    ec=$?
    if [[ $ec -eq 124 ]]; then
      bad "agentbox demo TIMED OUT (30s) — likely stdin not detached after wrap"
    else
      bad "agentbox demo failed (exit $ec)"
    fi
    tail -15 /tmp/agentbox-preflight-demo.log | sed 's/^/      /'
  fi

  # wrap a trivial command in an isolated cwd so we don't pollute the repo
  (
    cd "$TMP"
    printf "  ${DIM}→ agentbox wrap…${RESET}\n"
    if run_timed 15 node "$ROOT/bin/agentbox.js" wrap --name preflight -- \
      node -e "console.log('preflight-ok')" \
      >/tmp/agentbox-preflight-wrap.log 2>&1; then
      ok "agentbox wrap records a child process"
    else
      ec=$?
      if [[ $ec -eq 124 ]]; then
        bad "agentbox wrap TIMED OUT (15s)"
      else
        bad "agentbox wrap failed (exit $ec)"
      fi
      tail -10 /tmp/agentbox-preflight-wrap.log | sed 's/^/      /'
      exit 0
    fi

    SESSION=$(ls -t .agentbox/sessions/*.jsonl 2>/dev/null | head -1 || true)
    if [[ -n "$SESSION" ]]; then
      ok "session file created: $(basename "$SESSION")"
      if run_timed 10 node "$ROOT/bin/agentbox.js" verify "$SESSION" >/tmp/agentbox-preflight-verify.log 2>&1; then
        ok "agentbox verify: chain intact"
      else
        bad "agentbox verify failed"
      fi
      if run_timed 10 node "$ROOT/bin/agentbox.js" receipt "$SESSION" >/tmp/agentbox-preflight-receipt.log 2>&1; then
        ok "agentbox receipt renders"
      else
        bad "agentbox receipt failed"
      fi
      if run_timed 15 node "$ROOT/bin/agentbox.js" clip "$SESSION" --out "$TMP/clip.html" >/tmp/agentbox-preflight-clip.log 2>&1; then
        if [[ -f "$TMP/clip.html" ]]; then
          ok "agentbox clip wrote HTML"
        else
          bad "agentbox clip produced no file"
        fi
      else
        bad "agentbox clip failed"
      fi
    else
      bad "no session file after wrap"
    fi
  )

  # redaction smoke: secret must not land on disk
  (
    cd "$TMP"
    printf "  ${DIM}→ redaction smoke…${RESET}\n"
    # assemble at runtime so this script itself isn't flagged
    FAKE_SECRET="sk-""abcdefghijklmnopqrstuvwxyz""012345"
    run_timed 15 node "$ROOT/bin/agentbox.js" wrap --name redact-smoke -- \
      node -e "console.log('KEY=${FAKE_SECRET}')" \
      >/tmp/agentbox-preflight-redact.log 2>&1 || true
    SFILE=$(ls -t .agentbox/sessions/*redact-smoke*.jsonl 2>/dev/null | head -1 || true)
    if [[ -n "$SFILE" ]]; then
      if grep -qF "$FAKE_SECRET" "$SFILE"; then
        bad "redaction failed — secret found in session file"
      else
        ok "redaction: secret not present on disk"
      fi
      if grep -q '\[REDACTED\]' "$SFILE"; then
        ok "redaction: [REDACTED] placeholder present"
      else
        warn "redaction: no [REDACTED] placeholder (pattern may not have matched)"
      fi
    else
      warn "redaction smoke: no session file to inspect"
    fi
  )
else
  section "Live smoke"
  warn "skipped (--quick)"
fi

# ─── 7. Git hygiene (if in a git repo) ──────────────────────────────────────
section "Git hygiene"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git diff --quiet && git diff --cached --quiet; then
    ok "working tree clean"
  else
    warn "uncommitted changes present — commit or stash before posting"
  fi

  # scan last 5 commits for secret-like blobs (cheap)
  if git log -5 --pretty=format: --name-only 2>/dev/null | grep -q .; then
    hist=$(git grep -nE 'xox[baprs]-[0-9A-Za-z-]{10,}|ghp_[A-Za-z0-9]{20,}' $(git rev-list -5 HEAD) 2>/dev/null | head -5 || true)
    if [[ -n "$hist" ]]; then
      bad "secret-like strings in recent git history (push protection will block):"
      while IFS= read -r line; do printf "      ${DIM}%s${RESET}\n" "$line"; done <<< "$hist"
    else
      ok "no obvious secrets in last 5 commits (git grep)"
    fi
  fi
else
  warn "not a git repo — skip history checks"
fi

# ─── Summary ────────────────────────────────────────────────────────────────
printf "\n${BOLD}────────────────────────────────────────${RESET}\n"
printf "${BOLD}  preflight result${RESET}\n"
printf "  ${GREEN}passed${RESET}:  %d\n" "$PASS"
printf "  ${YELLOW}warnings${RESET}: %d\n" "$WARN"
printf "  ${RED}failed${RESET}:  %d\n" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  printf "\n${RED}${BOLD}✗ NOT READY TO POST${RESET}\n"
  printf "  Fix these first:\n"
  for f in "${failures[@]}"; do printf "    ${RED}•${RESET} %s\n" "$f"; done
  [[ $WARN -gt 0 ]] && printf "  Also consider:\n" && for w in "${warnings[@]}"; do printf "    ${YELLOW}•${RESET} %s\n" "$w"; done
  exit 1
fi

if [[ $WARN -gt 0 ]]; then
  printf "\n${YELLOW}${BOLD}✓ tests green, but warnings remain${RESET}\n"
  for w in "${warnings[@]}"; do printf "    ${YELLOW}•${RESET} %s\n" "$w"; done
  printf "  ${DIM}Post only if those are intentional (placeholders, etc.).${RESET}\n"
  exit 0
fi

printf "\n${GREEN}${BOLD}✓ CLEAR TO POST${RESET}\n"
printf "  ${DIM}Demo GIF + honest title + Security section link in first comment.${RESET}\n"
exit 0

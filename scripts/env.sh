#!/usr/bin/env bash
# diagnose-tests.sh — figure out why `node --test test/` fails in CI
# Usage: ./diagnose-tests.sh [test-target]
#   test-target defaults to "test" (the arg passed to node --test)

set -uo pipefail

TARGET="${1:-test}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || exit 1

# --- colors (disabled if not a tty) ---
if [ -t 1 ]; then
  R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; B=$'\e[34m'; D=$'\e[2m'; N=$'\e[0m'
else
  R=; G=; Y=; B=; D=; N=
fi

say()  { printf '%s\n' "$*"; }
hdr()  { printf '\n%s== %s ==%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$R" "$N" "$*"; }
info() { printf '  %s·%s %s\n' "$D" "$N" "$*"; }

# --- collected evidence for the final verdict ---
declare -a CAUSES=()

add_cause() { CAUSES+=("$1"); }

hdr "Context"
say "repo root:   $REPO_ROOT"
say "target arg:  $TARGET"
if command -v node >/dev/null 2>&1; then
  say "node:        $(node --version)"
else
  warn "node not found on PATH"
fi
say "git:         $(git rev-parse --short HEAD 2>/dev/null || echo 'no commits')"
say "branch:      $(git branch --show-current 2>/dev/null || echo 'detached')"

# ---------------------------------------------------------------
hdr "1. Does '$TARGET' exist on disk?"
if [ -e "$TARGET" ]; then
  if [ -d "$TARGET" ]; then
    ok "'$TARGET' is a directory"
    count=$(find "$TARGET" -type f | wc -l | tr -d ' ')
    info "files inside: $count"
    if [ "$count" -eq 0 ]; then
      bad "directory is EMPTY — git will not track it"
      add_cause "target directory '$TARGET' exists locally but is empty"
    fi
  elif [ -f "$TARGET" ]; then
    ok "'$TARGET' is a file"
  else
    warn "'$TARGET' exists but is neither file nor dir (symlink?)"
  fi
else
  bad "'$TARGET' does NOT exist at repo root"
  add_cause "target '$TARGET' does not exist at repo root"
fi

# ---------------------------------------------------------------
hdr "2. Is '$TARGET' tracked by git?"
tracked=$(git ls-files -- "$TARGET" 2>/dev/null | head -n 20)
if [ -n "$tracked" ]; then
  ok "tracked files under '$TARGET':"
  git ls-files -- "$TARGET" | sed 's/^/      /' | head -n 20
  total=$(git ls-files -- "$TARGET" | wc -l | tr -d ' ')
  info "total tracked: $total"
else
  bad "no files under '$TARGET' are tracked by git"
  add_cause "'$TARGET' has nothing committed — CI checkout will not contain it"
fi

# ---------------------------------------------------------------
hdr "3. Is '$TARGET' gitignored?"
if git check-ignore -v -- "$TARGET" >/dev/null 2>&1; then
  bad "'$TARGET' matches a .gitignore rule:"
  git check-ignore -v -- "$TARGET" | sed 's/^/      /'
  # also check a representative file if it's a dir
  if [ -d "$TARGET" ]; then
    sample=$(find "$TARGET" -type f | head -n 1 || true)
    if [ -n "$sample" ]; then
      info "sample file check: $sample"
      git check-ignore -v -- "$sample" 2>/dev/null | sed 's/^/      /' || info "sample not ignored"
    fi
  fi
  add_cause "'$TARGET' (or its contents) is gitignored"
else
  ok "'$TARGET' is not ignored"
fi

# ---------------------------------------------------------------
hdr "4. Case / spelling siblings"
shopt -s nullglob nocaseglob
sibs=( ./*"$TARGET"* )
shopt -u nocaseglob nullglob
if [ ${#sibs[@]} -gt 0 ]; then
  info "entries matching '$TARGET' (case-insensitive):"
  for s in "${sibs[@]}"; do
    printf '      %s\n' "$s"
  done
  # flag likely typos
  for s in "${sibs[@]}"; do
    base=$(basename "$s")
    if [ "$base" != "$TARGET" ]; then
      warn "case/name mismatch: '$base' vs target '$TARGET'"
      add_cause "name mismatch: repo has '$base' but command uses '$TARGET'"
    fi
  done
else
  info "no case-insensitive siblings found"
fi

# ---------------------------------------------------------------
hdr "5. Test files anywhere in repo"
found_test_files=$(find . -type f \
  \( -name '*.test.js' -o -name '*-test.js' -o -name 'test.js' \) \
  -not -path './node_modules/*' -not -path './.git/*' 2>/dev/null | head -n 20)
if [ -n "$found_test_files" ]; then
  ok "found test files:"
  printf '%s\n' "$found_test_files" | sed 's/^/      /'
else
  warn "no *.test.js / *-test.js / test.js files anywhere"
  add_cause "no conventional test files found in repo"
fi

# ---------------------------------------------------------------
hdr "6. package.json test script"
if [ -f package.json ]; then
  if command -v node >/dev/null 2>&1; then
    script=$(node -e "try{console.log(require('./package.json').scripts?.test||'')}catch(e){console.log('')}" 2>/dev/null)
  else
    script=$(grep -o '"test"[^,}]*' package.json | head -n1)
  fi
  if [ -n "$script" ]; then
    ok "npm test → $script"
    case "$script" in
      *"node --test "*) warn "passes an argument to --test; directory args are fragile across Node versions" ;;
    esac
  else
    warn "no 'test' script in package.json"
  fi
else
  warn "no package.json at repo root"
fi

# ---------------------------------------------------------------
hdr "7. CI workflow test commands"
if [ -d .github/workflows ]; then
  hits=$(grep -RInE 'node[[:space:]]+--test|npm[[:space:]]+(run[[:space:]]+)?test|yarn[[:space:]]+test|pnpm[[:space:]]+test' \
    .github/workflows 2>/dev/null || true)
  if [ -n "$hits" ]; then
    ok "found test invocations in workflows:"
    printf '%s\n' "$hits" | sed 's/^/      /'
  else
    info "no obvious test commands found in .github/workflows"
  fi
else
  info "no .github/workflows directory"
fi

# ---------------------------------------------------------------
hdr "8. Simulate CI: what would node see?"
if command -v node >/dev/null 2>&1; then
  if [ -e "$TARGET" ]; then
    info "target exists locally; CI only sees what git tracks + the working tree it checks out"
  else
    warn "target missing locally — CI will fail identically"
  fi
  # try a dry resolution the same way node does
  node -e "
    const fs=require('fs'),p=require('path');
    const t=p.resolve(process.argv[1]);
    if(fs.existsSync(t)){
      const st=fs.statSync(t);
      console.log('  node sees: '+(st.isDirectory()?'directory':st.isFile()?'file':'other'));
    } else {
      console.log('  node sees: MISSING (would throw MODULE_NOT_FOUND)');
    }
  " "$TARGET"
fi

# ---------------------------------------------------------------
hdr "9. Staged-but-uncommitted changes"
if ! git diff --quiet -- "$TARGET" 2>/dev/null || ! git diff --cached --quiet -- "$TARGET" 2>/dev/null; then
  warn "there are uncommitted or staged changes under '$TARGET'"
  git status --porcelain -- "$TARGET" | sed 's/^/      /'
  add_cause "uncommitted changes under '$TARGET' — CI won't have them"
else
  ok "no pending changes under '$TARGET'"
fi

# ---------------------------------------------------------------
hdr "VERDICT"
if [ ${#CAUSES[@]} -eq 0 ]; then
  ok "No obvious cause found for a 'Cannot find module' failure."
  info "If CI still fails, run this script *inside* the CI job to see what's actually checked out:"
  info "  add a workflow step:  - run: bash diagnose-tests.sh"
else
  bad "Likely root cause(s):"
  for c in "${CAUSES[@]}"; do
    printf '      - %s\n' "$c"
  done
  say ""
  case " ${CAUSES[*]} " in
    *"not exist at repo root"*|*"nothing committed"*|*"empty"*)
      say "  ${G}Fix:${N} create/commit the tests and push:"
      say "      mkdir -p $TARGET && \$EDITOR $TARGET/example.test.js"
      say "      git add $TARGET && git commit -m 'Add tests' && git push"
      ;;
    *"gitignored"*)
      say "  ${G}Fix:${N} un-ignore it, or force-add:"
      say "      git add -f $TARGET && git commit -m 'Track tests' && git push"
      ;;
    *"name mismatch"*)
      say "  ${G}Fix:${N} align the names, e.g.:"
      say "      git mv <actual-name> $TARGET   # or update the workflow/package.json"
      ;;
  esac
  say ""
  say "  ${G}Robust alternative:${N} drop the argument and let Node auto-discover:"
  say "      node --test"
  say "  or use an explicit glob (quoted so the shell doesn't expand it):"
  say "      node --test \"$TARGET/**/*.test.js\""
fi

exit 0
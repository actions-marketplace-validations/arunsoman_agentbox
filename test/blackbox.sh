#!/usr/bin/env bash
set -uo pipefail

# Public-interface acceptance tests. This suite intentionally imports nothing
# from src/: every assertion drives the shipped CLI as an external user would.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLI="$ROOT/bin/agentbox.js"
CASE_ROOT=$(mktemp -d /tmp/agentbox-blackbox.XXXXXX)
PASS=0
FAIL=0
TOTAL=0

cleanup() {
  case "$CASE_ROOT" in /tmp/agentbox-blackbox.*) rm -rf -- "$CASE_ROOT" ;; esac
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$TOTAL" "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'not ok %d - %s\n' "$TOTAL" "$1"; }
contains() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

run_case() {
  local name=$1
  shift
  TOTAL=$((TOTAL + 1))
  if "$@"; then ok "$name"; else bad "$name"; fi
}

case_help_version() {
  local help version
  help=$(node "$CLI" help) || return 1
  version=$(node "$CLI" version) || return 1
  contains "$help" 'agentbox' && contains "$help" 'wrap' && contains "$version" 'agentbox v'
}

case_unknown_command_shows_help() {
  local out
  out=$(node "$CLI" definitely-not-a-command) || return 1
  contains "$out" 'usage'
}

case_empty_project_is_graceful() {
  local dir="$CASE_ROOT/empty" list status
  mkdir -p "$dir"
  list=$(cd "$dir" && node "$CLI" list) || return 1
  contains "$list" 'no sessions yet' || return 1
  (cd "$dir" && node "$CLI" receipt >/dev/null 2>&1)
  status=$?
  [ "$status" -ne 0 ]
}

case_wrap_records_streams_and_exit() {
  local dir="$CASE_ROOT/wrap" session receipt status
  mkdir -p "$dir"
  (cd "$dir" && node "$CLI" wrap --quiet -- sh -c "printf 'hello-out\\n'; printf 'hello-err\\n' >&2") || return 1
  session=$(find "$dir/.agentbox/sessions" -name '*.jsonl' -print -quit) || return 1
  node "$CLI" verify "$session" >/dev/null || return 1
  receipt=$(node "$CLI" receipt "$session" --json) || return 1
  contains "$receipt" '"exitCode": 0' && contains "$receipt" '"stderrLines": 1'
}

case_wrap_preserves_failure_code() {
  local dir="$CASE_ROOT/exit" status
  mkdir -p "$dir"
  (cd "$dir" && node "$CLI" wrap --quiet -- sh -c 'exit 23')
  status=$?
  [ "$status" -eq 23 ]
}

case_wrap_missing_command_is_127() {
  local dir="$CASE_ROOT/missing" status
  mkdir -p "$dir"
  (cd "$dir" && node "$CLI" wrap --quiet -- agentbox-command-that-does-not-exist)
  status=$?
  [ "$status" -eq 127 ]
}

case_wrap_path_with_spaces() {
  local dir="$CASE_ROOT/path with spaces" session receipt
  mkdir -p "$dir"
  (cd "$dir" && node "$CLI" wrap --quiet --name 'space flight' -- printf '%s\n' 'hello world') || return 1
  session=$(find "$dir/.agentbox/sessions" -name '*.jsonl' -print -quit) || return 1
  receipt=$(node "$CLI" receipt "$session" --json) || return 1
  contains "$receipt" 'space flight' && grep -q 'hello world' "$session"
}

case_piped_stdin_is_forwarded_when_enabled() {
  local dir="$CASE_ROOT/stdin" session
  mkdir -p "$dir"
  printf 'answer-from-human\n' | (cd "$dir" && AGENTBOX_PIPE_STDIN=1 node "$CLI" wrap --quiet -- sh -c 'read line; printf "received:%s\\n" "$line"') || return 1
  session=$(find "$dir/.agentbox/sessions" -name '*.jsonl' -print -quit) || return 1
  grep -q 'received:answer-from-human' "$session" && grep -q 'answer-from-human' "$session"
}

case_tamper_is_rejected_everywhere() {
  local dir="$CASE_ROOT/tamper" session status list
  mkdir -p "$dir"
  (cd "$dir" && node "$CLI" wrap --quiet -- printf 'original\n') || return 1
  session=$(find "$dir/.agentbox/sessions" -name '*.jsonl' -print -quit) || return 1
  sed -i 's/original/altered/' "$session"
  node "$CLI" verify "$session" >/dev/null
  status=$?
  [ "$status" -ne 0 ] || return 1
  list=$(cd "$dir" && node "$CLI" list) || return 1
  contains "$list" 'BROKEN' || return 1
  node "$CLI" receipt "$session" --json >/dev/null 2>&1
  [ "$?" -ne 0 ]
}

case_boolean_flag_before_filename() {
  local dir="$CASE_ROOT/flags" session out
  mkdir -p "$dir"
  (cd "$dir" && node "$CLI" wrap --quiet --name wanted -- printf 'chosen-session\n') || return 1
  session=$(find "$dir/.agentbox/sessions" -name '*.jsonl' -print -quit) || return 1
  out=$(node "$CLI" replay --headless "$session") || return 1
  contains "$out" 'chosen-session'
}

case_redaction_default_and_opt_out() {
  local safe="$CASE_ROOT/redacted" unsafe="$CASE_ROOT/unredacted" a b token='sk-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH'
  mkdir -p "$safe" "$unsafe"
  (cd "$safe" && node "$CLI" wrap --quiet -- printf '%s\n' "$token") || return 1
  a=$(find "$safe/.agentbox/sessions" -name '*.jsonl' -print -quit) || return 1
  grep -q '\[REDACTED\]' "$a" && ! grep -q "$token" "$a" || return 1
  (cd "$unsafe" && AGENTBOX_REDACT=0 node "$CLI" wrap --quiet -- printf '%s\n' "$token") || return 1
  b=$(find "$unsafe/.agentbox/sessions" -name '*.jsonl' -print -quit) || return 1
  grep -q "$token" "$b"
}

case_receipt_formats() {
  local dir="$CASE_ROOT/receipts" session text md json
  mkdir -p "$dir"
  (cd "$dir" && node "$CLI" wrap --quiet -- printf 'wrote src/new.js\n') || return 1
  session=$(find "$dir/.agentbox/sessions" -name '*.jsonl' -print -quit) || return 1
  text=$(node "$CLI" receipt "$session" --quiet) || return 1
  md=$(node "$CLI" receipt "$session" --md) || return 1
  json=$(node "$CLI" receipt "$session" --json) || return 1
  contains "$text" 'files touched' && contains "$md" 'Files touched' && contains "$json" 'src/new.js'
}

case_clip_is_self_contained_and_safe() {
  local dir="$CASE_ROOT/clip" session output
  mkdir -p "$dir"
  (cd "$dir" && node "$CLI" wrap --quiet -- printf '%s\n' '</script><script>globalThis.pwned=1</script>') || return 1
  session=$(find "$dir/.agentbox/sessions" -name '*.jsonl' -print -quit) || return 1
  node "$CLI" clip "$session" --out "$dir/share.html" >/dev/null || return 1
  output="$dir/share.html"
  grep -qi '<!doctype html>' "$output" && grep -q 'payload-json' "$output" && ! grep -q '</script><script>globalThis.pwned' "$output"
}

case_clip_honors_time_range() {
  local dir="$CASE_ROOT/clip-range" session output
  mkdir -p "$dir"
  (cd "$dir" && node "$CLI" wrap --quiet -- sh -c "printf 'early\\n'; sleep 1; printf 'late\\n'") || return 1
  session=$(find "$dir/.agentbox/sessions" -name '*.jsonl' -print -quit) || return 1
  node "$CLI" clip "$session" --from 0 --to 0.5 --out "$dir/range.html" >/dev/null || return 1
  output="$dir/range.html"
  grep -q '"x":"early"' "$output" && ! grep -q '"x":"late"' "$output"
}

case_claude_init_is_idempotent_and_reversible() {
  local dir="$CASE_ROOT/claude" settings count
  mkdir -p "$dir/.claude"
  printf '{"custom":true}\n' > "$dir/.claude/settings.json"
  (cd "$dir" && node "$CLI" init claude >/dev/null) || return 1
  (cd "$dir" && node "$CLI" init claude >/dev/null) || return 1
  settings="$dir/.claude/settings.json"
  grep -q '"custom": true' "$settings" || return 1
  count=$(grep -o 'hook claude' "$settings" | wc -l | tr -d ' ')
  [ "$count" -eq 7 ] || return 1
  (cd "$dir" && node "$CLI" init claude --remove >/dev/null) || return 1
  grep -q 'hook claude' "$settings" && return 1
  grep -q '"custom": true' "$settings"
}

case_claude_hook_records_a_passive_session() {
  local dir="$CASE_ROOT/claude-hook" session receipt
  mkdir -p "$dir"
  printf '{"hook_event_name":"SessionStart","session_id":"bb-1","cwd":"%s","source":"startup"}\n' "$dir" | node "$CLI" hook claude
  printf '{"hook_event_name":"PreToolUse","session_id":"bb-1","cwd":"%s","tool_name":"Write","tool_input":{"file_path":"src/hook.js"}}\n' "$dir" | node "$CLI" hook claude
  printf '{"hook_event_name":"SessionEnd","session_id":"bb-1","cwd":"%s","reason":"done"}\n' "$dir" | node "$CLI" hook claude
  session=$(find "$dir/.agentbox/sessions" -name '*.jsonl' -print -quit) || return 1
  receipt=$(node "$CLI" receipt "$session" --json) || return 1
  contains "$receipt" '"adapter": "claude-code"' && contains "$receipt" 'src/hook.js'
}

case_mcp_proxy_records_tool_calls() {
  local dir="$CASE_ROOT/mcp" session receipt response
  mkdir -p "$dir"
  response=$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"}}}' |
    (cd "$dir" && node "$CLI" mcp --quiet -- sh -c 'while IFS= read -r line; do printf "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}\\n"; done')) || return 1
  contains "$response" '"result"' || return 1
  session=$(find "$dir/.agentbox/sessions" -name '*.jsonl' -print -quit) || return 1
  receipt=$(node "$CLI" receipt "$session" --json) || return 1
  contains "$receipt" '"toolCallStarts": 1' && contains "$receipt" '"toolCallEnds": 1'
}

case_tty_wrap_and_replay_interrupt() {
  command -v script >/dev/null || return 0
  local dir="$CASE_ROOT/tty" session status
  mkdir -p "$dir"
  (cd "$dir" && script -qefc "node '$CLI' wrap --quiet -- sh -c 'stty size'" /dev/null >/dev/null) || return 1
  session=$(find "$dir/.agentbox/sessions" -name '*.jsonl' -print -quit) || return 1
  grep -Eq '([0-9]+) ([0-9]+)' "$session" || return 1
  { sleep 0.5; printf '\003'; } | timeout 5 script -qefc "node '$CLI' replay '$session'" /dev/null >/dev/null 2>&1
  status=$?
  [ "$status" -eq 130 ] || [ "$status" -eq 0 ]
}

printf 'TAP version 13\n'
run_case 'help and version are available' case_help_version
run_case 'unknown command falls back to help' case_unknown_command_shows_help
run_case 'empty project commands fail gracefully' case_empty_project_is_graceful
run_case 'wrap records stdout, stderr, and clean exit' case_wrap_records_streams_and_exit
run_case 'wrap preserves child failure code' case_wrap_preserves_failure_code
run_case 'missing wrapped command exits 127' case_wrap_missing_command_is_127
run_case 'paths and arguments with spaces work' case_wrap_path_with_spaces
run_case 'opt-in piped stdin reaches the wrapped command' case_piped_stdin_is_forwarded_when_enabled
run_case 'tampering is rejected by verify, list, and receipt' case_tamper_is_rejected_everywhere
run_case 'boolean flag before filename selects requested session' case_boolean_flag_before_filename
run_case 'redaction defaults on and supports explicit opt-out' case_redaction_default_and_opt_out
run_case 'receipt text, markdown, and JSON formats work' case_receipt_formats
run_case 'clip is self-contained and neutralizes closing script tags' case_clip_is_self_contained_and_safe
run_case 'clip honors requested time ranges' case_clip_honors_time_range
run_case 'Claude hook install is idempotent and reversible' case_claude_init_is_idempotent_and_reversible
run_case 'Claude hooks record a passive session' case_claude_hook_records_a_passive_session
run_case 'MCP proxy records paired tool calls' case_mcp_proxy_records_tool_calls
run_case 'TTY wrap works and replay can be interrupted' case_tty_wrap_and_replay_interrupt

printf '1..%d\n' "$TOTAL"
printf '# pass %d\n# fail %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

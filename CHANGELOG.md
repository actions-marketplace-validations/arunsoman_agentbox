# Changelog

## 0.2.1 — secrets never leave the cockpit

- **Default-on redaction** — every event written to the tape is scrubbed before hashing
  - OpenAI / Anthropic / GitHub / AWS / Slack / Stripe / Google / Twilio tokens
  - Bearer headers, JWTs, PEM private keys
  - `password=` / `api_key=` / `"secret": "…"` style assignments
  - connection strings with embedded credentials
- Disable with `AGENTBOX_REDACT=0`; add patterns via `AGENTBOX_REDACT_EXTRA` or `.agentbox/config.json`
- Meta event records `redact: true|false` so the policy is self-describing
- Hash chain commits to the *redacted* form — the original secret never lands on disk
- Tests cover pattern hits, deep object walks, disable flag, and end-to-end wrap path

## 0.2.0 — passive mode (adapters)

- **Claude Code hook adapter** — `agentbox init claude` merges idempotent hooks into `.claude/settings.json` (`--local`, `--remove`); `agentbox hook claude` records SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Notification / Stop / SessionEnd per Claude session
  - engineered to never break a flight: exit 0 on any internal error, no stdout on the hot path, drop-instead-of-fork under lock contention, auto receipt on SessionEnd → `.agentbox/receipts/`
- **MCP wire tap** — `agentbox mcp -- <server cmd>` runs any MCP server behind a transparent recording proxy (newline-delimited JSON-RPC passthrough); every `tools/call` is hash-chained with arguments, result, status and duration; `agentbox init mcp` prints ready-to-paste configs for Claude Desktop / Cursor / Claude Code
- receipts + replay now understand structured events: `recorded via` row, agent turns, tool errors, human-readable tool labels (`Bash(npm test -- --ci)`), prompt details in markdown receipts
- chain.js: cross-process append primitives (`lastEvent`, `appendToChain`, `withFileLock`) so short-lived hook processes can extend an existing chain safely
- 15 tests (from 11): hook e2e incl. garbage-stdin resilience, MCP proxy e2e over real stdio, settings merge/uninstall idempotency

## 0.1.0 — first flight

- `wrap` — record any command/agent session to a tamper-evident sha256 hash chain (JSONL)
- `replay` — interactive TUI scrubber + `--headless` static frame
- `receipt` — text / markdown / json one-page summaries
- `clip` — self-contained shareable HTML clip export
- `verify`, `list`, `demo`
- GitHub Action: post flight receipts as PR comments
- Zero runtime dependencies. 100% local. No telemetry.

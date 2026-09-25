<div align="center">

# ⬢ AGENTBOX

### The black-box flight recorder for AI agents

**Your agents have root. Who's watching?**

`npm test` for your agent's behavior · tamper-evident · 100% local · zero dependencies

[![CI](https://github.com/arunsoman/agentbox/actions/workflows/ci.yml/badge.svg)](https://github.com/arunsoman/agentbox/actions/workflows/ci.yml)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A518-blue)
![license](https://img.shields.io/badge/license-MIT-black)
![telemetry](https://img.shields.io/badge/telemetry-none-success)

</div>

---

AI agents now run your shell, edit your files, and ship to prod — often with zero humans in the loop. The tooling explosion of 2026 made software *agent-native*… and produced exactly one new question:

> **"What did my agent actually do while I was away?"**

AGENTBOX is the answer. Strap a flight recorder to **any** command or agent — no SDK, no code changes, no cloud — and get a tamper-evident tape of everything it did: every tool call, every file touched, every URL hit. Scrub through it like security footage when (not if) something goes wrong.

```bash
npx agentbox-cli demo          # see it in 10 seconds — no install, no config
```

Or wrap your own agent:

```bash
agentbox wrap --name prod-deploy -- node agent.js "deploy the release"
⬢ agentbox: black box on → recording to .agentbox/sessions/2026-09-25T…-prod-deploy.jsonl
```

## 🧾 The receipt

Every session ends with a one-page flight receipt. This is **real output** from `agentbox demo`:

```
         ⬢  A G E N T B O X   R E C E I P T
┌──────────────────────────────────────────────────┐
│ session                 demo-deploy              │
│ command                 node examples/fake-agen… │
│ started                 2026-09-24 18:40:52      │
│ duration                5.4s                     │
│ exit code               0  (clean landing)       │
├──────────────────────────────────────────────────┤
│ tool calls              7                        │
│   · bash("git status --s…                        │
│   · write(src/deploy.sh …                        │
│   · bash("./deploy.sh --…                        │
│   … +4 more                                      │
│ shell commands          1                        │
│   · rm -rf /tmp/old-buil…                        │
│ files touched           2 · 1 written · 1 edited │
│   · src/deploy.sh       wrote                    │
│   · config.yaml         edited                   │
│ urls hit                1                        │
│ output volume           808 B across 17 lines    │
│ stderr lines            0                        │
│ humans consulted        0  (unsupervised flight) │
├──────────────────────────────────────────────────┤
│ events recorded         19                       │
│ tamper chain            sha256 · intact          │
└──────────────────────────────────────────────────┘
uneventful flight. the best kind.
```

## 📼 The replay

`agentbox replay <file>` opens an interactive scrubber — security footage for your terminal:

- **Timeline bar** with markers: `▲` tool call · `$` shell · `✎` file op · `i` human input
- **Play / pause / speed** (1×–64×) — skip to `00:47.2`, the moment it dropped the table
- **Every keystroke the human typed** is on the tape (`HUMAN` lines)
- `--headless` renders a static frame for CI, GIFs, and GitHub

Keys: `[space]` play/pause · `[←/→]` step event · `[j/k]` ±10s · `[[/]]` speed · `[g/G]` start/end · `[q]` quit

## 🔐 Tamper-evident tapes

Every event is hash-chained — each line commits to the previous one, Genesis to tip:

```
{ i, t, type, data, prev, hash }    hash = sha256(prev ‖ i ‖ t ‖ type ‖ data)
```

Edit one line — even a single character — and `agentbox verify` pins the exact event:

```
$ agentbox verify
✗ hash mismatch at event 7 — event was tampered with or forged
```

This detects accidental corruption and edits that do not rebuild the chain. Because the chain is not signed or externally anchored, someone who can rewrite the whole file can also recompute its hashes. Treat it as an integrity check and audit aid—not cryptographic proof of origin.

## 🛡️ Security & privacy

**Secrets never land on the tape.** Every string written to a session file is scrubbed *before* it is hashed and appended. The chain commits to the redacted form, so the original secret is not recoverable from the file, the receipt, or a shared clip.

Default patterns catch:

| Family | Examples |
|--------|----------|
| API tokens | OpenAI `sk-…`, Anthropic `sk-ant-…`, GitHub `ghp_…`, Stripe `sk_live_…`, Slack `xoxb-…`, Google `AIza…` |
| Cloud keys | AWS `AKIA…` / secret-access-key assignments |
| Auth headers | `Bearer …`, JWTs |
| Private keys | `-----BEGIN … PRIVATE KEY-----` |
| Assignments | `password=…`, `api_key=…`, `"client_secret": "…"` |
| Connection strings | `postgres://user:pass@host/db` |

**Controls**

```bash
AGENTBOX_REDACT=0              # disable (not recommended)
AGENTBOX_REDACT_EXTRA='myco-.*|internal-token-\w+'   # extra JS regexes, | -separated
```

Or project-local config:

```json
// .agentbox/config.json
{
  "redact": true,
  "redactPatterns": ["my-internal-secret-[A-Z0-9]+"]
}
```

The session meta event records `redact: true|false` so the policy is visible on the tape. Redaction is deterministic — same input always yields the same placeholder — which keeps the hash chain stable.

> Still treat session files as sensitive. Redaction is best-effort pattern matching; novel secret formats can slip through. Do not commit `.agentbox/` to public repos without review.

## 🚀 Quickstart

```bash
# 1. Watch a scripted agent get recorded (10 seconds)
npx agentbox-cli demo

# 2. Wrap anything — your agent, a script, any CLI
agentbox wrap -- claude "refactor auth.js"
agentbox wrap --name eval-run -- python evaluate.py --suite prod

# 3. Read the tape
agentbox list                    # all sessions
agentbox receipt                 # newest session, one page
agentbox replay <file>           # scrub the footage
agentbox verify                  # tamper check

# 4. Share a moment, not a dump
agentbox clip <file> --from 30 --to 75   # → self-contained .clip.html

# 5. Or skip the wrapper entirely — passive mode
agentbox init claude                     # hooks → every claude session, recorded
agentbox mcp -- npx -y @modelcontextprotocol/server-everything   # wire tap
```

No install, no config, no accounts. Sessions land in `./.agentbox/sessions/` next to your repo — commit them if you want receipts in git history.

## 👻 Passive mode — no wrapper needed

Wrapping is for flights you know about in advance. Adapters are for the ones you don't.

### Claude Code hooks — one command, then forget about it

```bash
agentbox init claude        # merges hooks into .claude/settings.json (idempotent, backs up first)
agentbox init claude --local   # .claude/settings.local.json instead (gitignored by default)
agentbox init claude --remove  # clean uninstall
```

From the next session on, Claude Code quietly feeds every event to `agentbox hook claude`:

| hook event | what lands on the tape |
|---|---|
| `SessionStart` | flight opened |
| `UserPromptSubmit` | every prompt you type |
| `PreToolUse` | every tool call **before it runs** — name + full arguments |
| `PostToolUse` | every result — ok / error |
| `Notification` | agent pings ("needs your permission to run `rm -rf`") |
| `Stop` | turn boundaries |
| `SessionEnd` | flight closed + **auto receipt** → `.agentbox/receipts/` |

The hook handler is engineered to be invisible: exits 0 even when agentbox itself fails, never prints to stdout, drops an event under contention rather than corrupt the chain. **If recording ever breaks, the agent doesn't.** And because tool calls are captured *structured* — not scraped off a TUI — receipts for passive sessions read better than wrapped ones:

```
│ recorded via            claude code hooks                        │
│ tool calls              12                                       │
│   · Bash(npm test -- --ci)                                       │
│   · Edit(src/auth.js — session rotation)                         │
│ files touched           3 · 2 edited · 1 written                 │
```

### MCP — the wire tap between agent and tools

An agent's *real* capability boundary is its MCP servers. Agentbox runs any server behind a recording proxy:

```
┌────────┐  JSON-RPC   ┌─────────────┐  JSON-RPC   ┌──────────────┐
│ agent  │ ──────────► │ agentbox mcp  │ ──────────► │ real server  │
│ client │ ◄────────── │  (records)  │ ◄────────── │  (unchanged) │
└────────┘             └─────────────┘             └──────────────┘
```

```bash
agentbox mcp -- npx -y @modelcontextprotocol/server-everything
agentbox init mcp -- npx -y @modelcontextprotocol/server-everything   # prints config blocks
```

Point any MCP client at agentbox instead of the server — Claude Desktop, Cursor, Claude Code (`.mcp.json`), any harness. The proxy forwards messages verbatim (zero protocol awareness needed by the server) and hash-chains every `tools/call`: arguments before, result after, duration between, error status included. `agentbox verify` works on wire taps exactly like wrapped flights.

> Wrap = capture the terminal. Hooks = capture the session. Wire tap = capture the protocol. Same tape, same receipts, same integrity checks.

## 🤖 The GitHub Action

Post a flight receipt on every PR an agent touches:

```yaml
permissions:
  issues: write

steps:
- uses: arunsoman/agentbox@v1
  if: always()
  with:
    session: .agentbox/sessions/deploy.jsonl   # optional, defaults to newest
```

The PR gets a markdown receipt — tool calls, files touched, exit code, chain status. Reviewers see what the agent did *before* they read a single diff. Workflows triggered from forks normally receive a read-only token and cannot post comments; use a separately reviewed workflow if fork comments are required.

## 🧠 How it works

```
                ┌──────────────────────────────────────┐
                │  agentbox wrap -- <any command>        │
                └───────────────┬──────────────────────┘
                                │ spawn (zero code changes)
        ┌───────────┬───────────┼───────────┬──────────────┐
        ▼           ▼           ▼           ▼              ▼
     stdout      stderr      stdin        exit         signals
        │           │           │           │              │
        └───────────┴─────┬─────┴───────────┴──────────────┘
                          ▼
              line classifier (heuristics)
              tool · shell · file · net · human
                          │
                          ▼
          ┌─────────────────────────────────┐
          │  hash-chained JSONL tape        │   ← tamper-evident
          │  .agentbox/sessions/*.jsonl       │   ← 100% local
          └─────────────────────────────────┘
                │            │            │
                ▼            ▼            ▼
             replay       receipt        clip
             (TUI)      (text/md/json)  (HTML)
```

AGENTBOX records the *terminal truth* — everything the process actually emitted — then classifies lines with transparent heuristics (`[TOOL] name(args)` convention, shell-command patterns, file-op verbs, URLs). Bring-your-own parser plugins are on the roadmap; the tape stays raw either way.

## ⚡ Zero dependencies. Literally.

The entire runtime is Node built-ins — `crypto`, `fs`, `child_process`. No `node_modules`. No supply chain. No phone-home. A flight recorder you can't audit would be a joke, so agentbox is ~1,000 lines of auditable code.

```bash
git clone https://github.com/arunsoman/agentbox && cd agentbox
node --test                 # nothing to install. there is nothing to install.
```

## 🗺️ Roadmap

- [x] ~~MCP / Claude Code hook adapters (record without wrapping)~~ — **shipped in 0.2.0**: `agentbox init claude`, `agentbox hook`, `agentbox mcp`
- [ ] `agentbox diff <a> <b>` — compare two runs of the same task
- [ ] `agentbox guard` — replay a session against rules, fail CI on violations
- [ ] Parser plugins for popular agent frameworks
- [ ] Windows raw-mode polish (works via WSL today)
- [ ] `agentbox canary` — crash-only checkpoints + resume

## 🤝 Contributing

Three hard rules: **zero runtime deps**, **100% local**, **never silently weaken tape integrity**. Everything else is negotiable. See [CONTRIBUTING.md](CONTRIBUTING.md).

## FAQ

**Does this work with Claude Code / Cursor / OpenClaw / my framework?**
Three ways, all first-class: `agentbox wrap -- <your agent command>` for anything in a terminal, `agentbox init claude` for passive Claude Code capture, and `agentbox mcp -- <server>` for any MCP client. Same tape underneath.

**Isn't this just logging?**
Logging is usually unstructured text. AGENTBOX adds a hash-linked integrity check, classification, replay, and shareable clips. It is universal—one recorder for every agent, not one per framework—but an unsigned local tape is not independently authenticated.

**Why not a SaaS dashboard?**
Because the answer to "can I trust my agent" should not be "trust this vendor too." Your black box lives in your repo, works offline forever, and can be audited in an afternoon.

**Where do sessions go?**
`./.agentbox/sessions/` — plain JSONL, commit-able, grep-able, yours.

---

<div align="center">

**If your agent has ever scared you at 2am, you need a black box.** ⭐

MIT © 2026 AGENTBOX contributors — *fly safe.*

</div>

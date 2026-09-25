# Contributing

AGENTBOX is deliberately tiny. Three hard rules:

1. **Zero runtime dependencies.** `node_modules` is where trust goes to die. Node built-ins only.
2. **100% local.** No accounts, no network calls, no telemetry, ever.
3. **The tape cannot lie.** Every feature must respect the hash chain — no silent log editing.

## Dev setup

```bash
git clone https://github.com/arunsoman/agentbox && cd agentbox
node --test test/      # no npm install needed. there is nothing to install.
node bin/agentbox.js demo
```

## Good first issues

- New parser rules for `src/parse.js` (your agent framework's log format)
- More `replay` keybindings / mouse support
- A `agentbox diff` that compares two sessions of the same task
- Windows raw-mode polish

Open an issue before big changes. Ship small PRs. Bring receipts.

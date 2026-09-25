'use strict';
/**
 * agentbox — adapters/claude.js
 * The Claude Code hook adapter: passive capture, no wrapper needed.
 *
 *   agentbox init claude       # one command: wires hooks into .claude/settings.json
 *   agentbox hook claude       # what every hook invocation runs (reads the
 *                            # hook payload JSON from stdin, appends one
 *                            # hash-chained event, exits 0 — ALWAYS)
 *
 * Design rules (a recorder must never break a flight):
 *   1. exit 0 no matter what — even on internal errors
 *   2. never print to stdout on the hot path (hooks parse stdout as control JSON)
 *   3. drop events under contention rather than fork the hash chain
 *   4. per-Claude-session file, deterministic name → zero state files
 *
 * Session mapping: claude session_id → .agentbox/sessions/<stamp>-claude-<sid>.jsonl
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  VERSION, loadEvents, verifyChain, appendToChain, withFileLock, sessionsDir,
} = require('../chain');
const { summarize, verdict } = require('../parse');
const { markdownReceipt } = require('../receipt');

// The hook events agentbox manages in settings.json. Entries are recognized
// for idempotent re-init / --remove by this marker inside the command string.
const HOOK_MARKER = 'hook claude';
const MANAGED_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'SessionEnd',
];

function trunc(s, n) {
  const str = s == null ? '' : String(s);
  return str.length <= n ? str : str.slice(0, n);
}

/** Shrink a tool payload: keep objects under cap chars, else stringify+truncate. */
function slim(v, cap) {
  if (v == null) return null;
  if (typeof v === 'string') return trunc(v, cap);
  try {
    const j = JSON.stringify(v);
    if (j.length <= cap) return v;
    return trunc(j, cap);
  } catch { return trunc(String(v), cap); }
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    const timer = setTimeout(() => { try { process.stdin.destroy(); } catch { /* gone */ } resolve(buf); }, 10000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(buf); });
  });
}

/** Deterministic session file for a Claude session_id (no state file needed). */
function claudeSessionFile(cwd, sid) {
  const dir = sessionsDir(cwd);
  const safe = String(sid || 'unknown').replace(/[^\w-]/g, '').slice(0, 64) || 'unknown';
  const suffix = `-claude-${safe}.jsonl`;
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).sort(); } catch { /* no dir yet */ }
  if (files.length) return path.join(dir, files[files.length - 1]);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(dir, `${stamp}${suffix}`);
}

function toolResponseIsError(resp) {
  if (!resp || typeof resp !== 'object') return false;
  if (resp.is_error === true || resp.isError === true) return true;
  return typeof resp.error === 'string' && resp.error.length > 0;
}

/** Write the auto receipt on SessionEnd (`.agentbox/receipts/<session>.md`). */
function autoReceipt(cwd, file) {
  if (process.env.AGENTBOX_HOOKS_RECEIPT === '0') return;
  const res = verifyChain(file);
  if (!res.ok) return;
  const stats = summarize(res.events);
  const dir = path.join(cwd, '.agentbox', 'receipts');
  fs.mkdirSync(dir, { recursive: true });
  const md = [
    '# ⬢ agentbox — flight receipt (auto-generated on session end)',
    '',
    markdownReceipt(stats, true),
    '',
    `> ${verdict(stats)}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, path.basename(file).replace(/\.jsonl$/, '.md')), md);
}

/**
 * Route one hook payload into the chain. Sync on purpose — the process
 * exits right after. Called under the session file lock.
 */
function recordHookEvent(ev) {
  const sid = ev.session_id || 'unknown';
  const sidSafe = String(sid).replace(/[^\w-]/g, '').slice(0, 64) || 'unknown';
  const cwd = ev.cwd && typeof ev.cwd === 'string' && fs.existsSync(ev.cwd) ? ev.cwd : process.cwd();
  const file = claudeSessionFile(cwd, sid);
  const isNew = !fs.existsSync(file);

  withFileLock(file, (locked) => {
    if (!locked) return; // contention timeout — drop the event, exit 0 (rule 3)
    if (isNew) {
      appendToChain(file, 'meta', {
        name: `claude-${sidSafe.slice(0, 8)}`,
        cmd: 'claude (passive — via hooks)',
        argv: ['claude'],
        adapter: 'claude-code',
        session_id: sid,
        cwd,
        user: os.userInfo().username,
        host: os.hostname(),
        platform: `${process.platform} ${process.arch}`,
        agentbox: VERSION,
        pid: process.pid,
      });
    }

    switch (ev.hook_event_name) {
      case 'SessionStart':
        appendToChain(file, 'note', { message: `session start (${ev.source || 'startup'})` });
        break;
      case 'UserPromptSubmit':
        appendToChain(file, 'prompt', { text: trunc(ev.prompt, 1000), source: 'claude-code' });
        break;
      case 'PreToolUse':
        appendToChain(file, 'tool_call', {
          phase: 'start',
          name: String(ev.tool_name || 'unknown'),
          input: slim(ev.tool_input, 2000),
          tool_use_id: ev.tool_use_id == null ? null : String(ev.tool_use_id),
          source: 'claude-code',
        });
        break;
      case 'PostToolUse':
        appendToChain(file, 'tool_call', {
          phase: 'end',
          name: String(ev.tool_name || 'unknown'),
          tool_use_id: ev.tool_use_id == null ? null : String(ev.tool_use_id),
          status: toolResponseIsError(ev.tool_response) ? 'error' : 'ok',
          preview: slim(ev.tool_response, 500),
          source: 'claude-code',
        });
        break;
      case 'Notification':
        appendToChain(file, 'notification', { message: trunc(ev.message, 300) });
        break;
      case 'Stop':
        appendToChain(file, 'turn_end', {});
        break;
      case 'SubagentStop':
        appendToChain(file, 'note', { message: 'subagent stopped' });
        break;
      case 'PreCompact':
        appendToChain(file, 'note', { message: 'context compacted' });
        break;
      case 'SessionEnd': {
        let started = null;
        try { started = loadEvents(file).events.find((e) => e.type === 'meta'); } catch { /* keep null */ }
        appendToChain(file, 'exit', {
          code: 0,
          durationMs: started ? Date.now() - started.t : null,
          reason: ev.reason || 'session-end',
          source: 'claude-code',
        });
        try { autoReceipt(cwd, file); } catch { /* receipt is a luxury, never a failure */ }
        break;
      }
      default:
        // Unknown/forward-compatible hook events still land on the tape.
        appendToChain(file, 'note', { message: `hook: ${ev.hook_event_name || 'unknown-event'}` });
    }
  });
}

/** `agentbox hook claude` — read payload, record, exit 0. Always. */
async function runHook() {
  let ev = {};
  try { ev = JSON.parse((await readStdin()) || '{}'); } catch { ev = { hook_event_name: 'unknown-event' }; }
  try {
    recordHookEvent(ev);
  } catch (e) {
    if (process.env.AGENTBOX_DEBUG) {
      process.stderr.write(`agentbox hook: swallowed error: ${e && e.message}\n`);
    }
  }
  process.exit(0); // rule 1: the flight always continues
}

/** Absolute, space-safe command string that lands inside settings.json hooks. */
function hookCommand() {
  const bin = path.join(__dirname, '..', '..', 'bin', 'agentbox.js');
  return `node "${bin}" ${HOOK_MARKER}`;
}

function settingsPath(opts) {
  return path.join(process.cwd(), '.claude', opts && opts.local ? 'settings.local.json' : 'settings.json');
}

function entryIsOurs(entry) {
  return entry && Array.isArray(entry.hooks) && entry.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(HOOK_MARKER));
}

/**
 * `agentbox init claude [--local] [--remove]`
 * Merge agentbox hooks into .claude/settings.json (idempotent), or strip them.
 * Returns { file, changed, events }.
 */
function initClaude(opts = {}) {
  const file = settingsPath(opts);
  const existed = fs.existsSync(file);
  let settings = {};
  if (existed) {
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      process.stderr.write(`⬢ agentbox: cannot parse ${file} — ${e.message}\nfix it first, or use --local for a separate file\n`);
      process.exitCode = 1;
      return { file, changed: false };
    }
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

  let changed = 0;

  if (opts.remove) {
    for (const event of Object.keys(settings.hooks)) {
      const groups = settings.hooks[event];
      if (!Array.isArray(groups)) continue;
      const kept = groups.filter((g) => !entryIsOurs(g));
      if (kept.length !== groups.length) changed += groups.length - kept.length;
      if (kept.length) settings.hooks[event] = kept;
      else delete settings.hooks[event];
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
  } else {
    // first-time safety net: never clobber a hand-written settings file silently
    if (existed && !fs.existsSync(`${file}.agentbox-backup`)) {
      try { fs.copyFileSync(file, `${file}.agentbox-backup`); } catch { /* best effort */ }
    }
    const cmd = hookCommand();
    for (const event of MANAGED_EVENTS) {
      const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      if (groups.some(entryIsOurs)) continue; // idempotent
      groups.push({ hooks: [{ type: 'command', command: cmd }] });
      settings.hooks[event] = groups;
      changed += 1;
    }
  }

  if (changed > 0 || !existed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  }

  const CYAN = '\x1b[36m'; const BOLD = '\x1b[1m'; const DIM = '\x1b[2m'; const GREEN = '\x1b[32m'; const RESET = '\x1b[0m';
  if (opts.remove) {
    process.stdout.write(`${CYAN}${BOLD}⬢ agentbox${RESET}: removed ${changed} hook entr${changed === 1 ? 'y' : 'ies'} from ${DIM}${file}${RESET}\n`);
  } else if (changed === 0) {
    process.stdout.write(`${CYAN}${BOLD}⬢ agentbox${RESET}: hooks already installed in ${DIM}${file}${RESET} ${GREEN}(nothing to do)${RESET}\n`);
  } else {
    process.stdout.write(`${CYAN}${BOLD}⬢ agentbox${RESET}: passive mode ON — ${changed} hooks → ${DIM}${file}${RESET}\n`);
    if (existed) process.stdout.write(`${DIM}  original backed up to ${file}.agentbox-backup${RESET}\n`);
    process.stdout.write(`
  ${BOLD}what gets recorded${RESET} (per claude session → .agentbox/sessions/):
    SessionStart      flight opened
    UserPromptSubmit  every prompt you type
    PreToolUse        every tool call before it runs (name + arguments)
    PostToolUse       every result (ok / error)
    Notification      agent pings
    Stop              turn boundaries
    SessionEnd        flight closed + auto receipt → .agentbox/receipts/

  ${BOLD}next${RESET}: start a ${DIM}claude${RESET} session in this project, then:
    agentbox list        see the flight
    agentbox receipt     read the tape
`);
    process.stdout.write(`${DIM}  hooks are read at session start — restart claude to pick them up${RESET}\n`);
  }
  return { file, changed };
}

module.exports = { runHook, initClaude, claudeSessionFile, HOOK_MARKER, MANAGED_EVENTS };

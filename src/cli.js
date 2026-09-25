'use strict';
/**
 * mayday — cli.js
 * Zero-dependency argv router. Every command works offline, no accounts,
 * no telemetry. Sessions live in ./.mayday/sessions/ next to your repo.
 */
const fs = require('fs');
const path = require('path');
const { VERSION, verifyChain, sessionsDir } = require('./chain');
const { wrap } = require('./wrap');
const { replay, renderStatic } = require('./replay');
const { receipt } = require('./receipt');
const { clip } = require('./clip');
const { summarize, fmtDuration } = require('./parse');
const { runHook, initClaude } = require('./adapters/claude');
const { runMcpProxy, initMcp } = require('./adapters/mcp');

const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const HELP = `
${CYAN}${BOLD}⬢ mayday v${VERSION}${RESET} — the black-box flight recorder for AI agents

${BOLD}usage${RESET}: mayday <command> [options]

  ${BOLD}wrap${RESET} [--name n] -- <cmd…>    record a command/agent session (black box on)
  ${BOLD}init${RESET} claude [--local]        passive mode: claude code hooks (one command)
  ${BOLD}init${RESET} mcp -- <server cmd>     print MCP wire-tap config for your client
  ${BOLD}mcp${RESET} [--name n] -- <server…>  run an MCP server behind the recording proxy
  ${BOLD}hook${RESET}                         (internal) record one claude code hook event from stdin
  ${BOLD}demo${RESET}                        record a scripted demo agent, then explore it
  ${BOLD}list${RESET}                        list recorded sessions
  ${BOLD}replay${RESET} [file]               scrub through a session like security footage
  ${BOLD}receipt${RESET} [file] [--md|--json] one-page summary of what happened
  ${BOLD}clip${RESET} [file] [--from s --to s]  export a shareable, self-contained HTML clip
  ${BOLD}verify${RESET} [file]               check the tamper-evident sha256 hash chain
  ${BOLD}help${RESET}                        show this help

${DIM}sessions live in ./.mayday/sessions/ · zero deps · 100% local · no telemetry
your agent has root. who's watching?${RESET}
`;

function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { flags._.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next != null && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else if (a === '-md') { flags.md = true; }
    else if (a === '-json') { flags.json = true; }
    else flags._.push(a);
  }
  return flags;
}

/** newest-first list of session files */
function findSessions() {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f))
    .sort()
    .reverse();
}

function resolveSession(fileArg) {
  if (fileArg && fs.existsSync(fileArg)) return fileArg;
  const sessions = findSessions();
  if (!sessions.length) return null;
  return sessions[0]; // most recent
}

function cmdList() {
  const files = findSessions();
  if (!files.length) {
    process.stdout.write(`${DIM}no sessions yet — try: ${RESET}mayday demo\n`);
    return;
  }
  process.stdout.write(`${BOLD}⬢ recorded sessions${RESET} ${DIM}(.mayday/sessions/)${RESET}\n\n`);
  for (const f of files) {
    let meta = null;
    let dur = '?';
    let code = '?';
    let n = 0;
    try {
      const res = verifyChain(f);
      const stats = summarize(res.events);
      meta = stats.name;
      dur = fmtDuration(stats.durationMs);
      code = String(stats.exitCode);
      n = res.events.length;
    } catch { /* skip details */ }
    const ok = '✓';
    process.stdout.write(`  ${DIM}${path.basename(f)}${RESET}\n    ${CYAN}${BOLD}${meta || '?'}${RESET}  ·  ${n} events · ${dur} · exit ${code === '0' ? GREEN + '0 ✓' : RED + code + RESET} · chain ${GREEN}${ok}${RESET}\n`);
  }
  process.stdout.write(`\n${DIM}replay one: mayday replay <file>${RESET}\n`);
}

function cmdVerify(fileArg) {
  const file = resolveSession(fileArg);
  if (!file) { process.stderr.write('no session file found\n'); process.exitCode = 1; return; }
  const res = verifyChain(file);
  if (res.ok) {
    process.stdout.write(`${GREEN}✓ chain intact${RESET} — ${res.count} events, sha256 from genesis to tip\n  ${DIM}${file}${RESET}\n`);
  } else {
    process.stdout.write(`${RED}✗ ${res.reason}${RESET}\n  ${DIM}${file}${RESET}\n`);
    process.exitCode = 1;
  }
}

function cmdDemo() {
  const demoScript = path.join(__dirname, '..', 'examples', 'fake-agent.js');
  // prefer a repo-relative path in receipts when run from inside the repo
  const rel = path.relative(process.cwd(), demoScript);
  const demoArg = rel && !rel.startsWith('..') ? rel : demoScript;
  process.stdout.write(`${CYAN}${BOLD}⬢ mayday demo${RESET} — strapping a black box to a scripted agent\n\n`);
  wrap(['node', demoArg], { name: 'demo-deploy' })
    .then(({ file, exitCode }) => {
      process.stdout.write('\n');
      receipt(file, { format: 'text' });
      process.stdout.write(`  ${DIM}now try:${RESET}   mayday replay ${path.basename(file)}\n`);
      process.stdout.write(`  ${DIM}share a clip:${RESET} mayday clip ${path.basename(file)}\n`);
      // explicit exit — wrap used to leave stdin resumed, which kept the
      // process alive after the agent finished (preflight / CI hang).
      process.exit(exitCode !== 0 ? (exitCode > 0 ? exitCode : 1) : 0);
    })
    .catch((e) => {
      process.stderr.write(`demo failed: ${e.message}\n`);
      process.exit(1);
    });
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
  const flags = parseFlags(argv.slice(1));
  const fileArg = flags._.find((a) => a.endsWith('.jsonl')) || flags._[0];

  switch (cmd) {
    case 'wrap': {
      const cmdArgs = flags._.length && fs.existsSync(flags._[0]) === false && flags['--'] === undefined
        ? flags._
        : flags._;
      // `mayday wrap --name x -- node agent.js` → after flag parse, remaining positional args ARE the command
      const target = cmdArgs.length ? cmdArgs : null;
      if (!target) {
        process.stderr.write('usage: mayday wrap [--name n] -- <command> [args…]\n');
        process.exitCode = 1;
        return;
      }
      wrap(target, { name: flags.name, quiet: flags.quiet })
        .then(({ exitCode }) => {
          process.exit(exitCode !== 0 ? (exitCode > 0 ? exitCode : 1) : 0);
        })
        .catch((e) => {
          process.stderr.write(`wrap failed: ${e.message}\n`);
          process.exit(1);
        });
      return;
    }
    case 'demo': return cmdDemo();
    case 'hook':
      // never fails, never prints — the agent's flight continues regardless
      runHook().catch(() => process.exit(0));
      return;
    case 'mcp': {
      const raw = argv.slice(1);
      const dd = raw.indexOf('--');
      const serverArgs = dd >= 0 ? raw.slice(dd + 1) : flags._;
      if (!serverArgs.length) {
        process.stderr.write('usage: mayday mcp [--name n] -- <server command> [args…]\nexample: mayday mcp -- npx -y @modelcontextprotocol/server-everything\n');
        process.exitCode = 1;
        return;
      }
      runMcpProxy(serverArgs, { name: flags.name, quiet: flags.quiet })
        .then(({ exitCode }) => { if (exitCode) process.exitCode = exitCode; })
        .catch((e) => { process.stderr.write(`mcp failed: ${e.message}\n`); process.exitCode = 1; });
      return;
    }
    case 'init': {
      const sub = flags._[0];
      if (sub === 'claude') {
        initClaude({ local: !!flags.local, remove: !!flags.remove });
        return;
      }
      if (sub === 'mcp') {
        const raw = argv.slice(1);
        const dd = raw.indexOf('--');
        const serverArgs = dd >= 0 ? raw.slice(dd + 1) : flags._.slice(1);
        initMcp(serverArgs);
        return;
      }
      process.stderr.write('usage: mayday init claude [--local] [--remove]\n       mayday init mcp -- <server command>\n');
      process.exitCode = 1;
      return;
    }
    case 'list': case 'ls': return cmdList();
    case 'verify': return cmdVerify(fileArg);
    case 'receipt': {
      const file = resolveSession(fileArg);
      if (!file) { process.stderr.write('no session file found — record one first: mayday demo\n'); process.exitCode = 1; return; }
      const format = flags.json ? 'json' : (flags.md || flags.markdown ? 'markdown' : 'text');
      const r = receipt(file, { format, force: flags.force });
      if (r.ok && !flags.quiet && format === 'text') {
        process.stdout.write(`  ${DIM}full tape:${RESET} mayday replay ${path.basename(file)}\n`);
      }
      return;
    }
    case 'clip': {
      const file = resolveSession(fileArg);
      if (!file) { process.stderr.write('no session file found — record one first: mayday demo\n'); process.exitCode = 1; return; }
      const out = clip(file, {
        from: flags.from != null ? Number(flags.from) : undefined,
        to: flags.to != null ? Number(flags.to) : undefined,
        out: flags.out,
        force: flags.force,
      });
      if (out) process.stdout.write(`${GREEN}✓ clip saved${RESET} ${DIM}${out}${RESET} — open it, or drop it straight into a PR\n`);
      return;
    }
    case 'replay': {
      const file = resolveSession(fileArg);
      if (!file) { process.stderr.write('no session file found — record one first: mayday demo\n'); process.exitCode = 1; return; }
      replay(file, { headless: flags.headless, force: flags.force, tail: flags.tail ? Number(flags.tail) : undefined });
      return;
    }
    case 'version': case '--version': case '-v':
      process.stdout.write(`mayday v${VERSION}\n`);
      return;
    case 'help': case '--help': case '-h':
    default:
      process.stdout.write(HELP);
      return;
  }
}

module.exports = main;

if (require.main === module) main();

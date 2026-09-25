'use strict';
/**
 * agentbox — receipt.js
 * The one-page flight receipt: what happened, in numbers a human can scan
 * in 5 seconds. Formats: text (POS-receipt aesthetic), markdown (PRs),
 * json (machines).
 */
const { verifyChain } = require('./chain');
const { summarize, fmtDuration, fmtBytes, verdict } = require('./parse');

const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const ORANGE = '\x1b[38;5;208m';

const W = 52; // inner width

function visibleLen(s) {
  return String(s || '').replace(/\x1b(?:\[[0-9;]*[A-HJKSTfmnsu]|\][^\x07]*(?:\x07|\x1b\\)|[P^_].*?\x1b\\)/g, '').length;
}

function pad(s, w) {
  s = String(s);
  const len = visibleLen(s);
  if (len > w) return pad(s.slice(0, Math.max(0, w - 1)), w) + '…';
  return s + ' '.repeat(Math.max(0, w - len));
}
function row(label, value) {
  return `│ ${pad(label, 24)}${pad(value, W - 27)}│`;
}
/** multi-row value: wraps long values across continuation rows */
function rowsFor(label, value) {
  const out = [];
  const chunks = String(value == null ? '' : value).match(/.{1,24}(\s|$)|\S+/g) || [''];
  out.push(row(label, chunks[0] || ''));
  for (let i = 1; i < chunks.length; i++) out.push(row(i === chunks.length - 1 ? '' : '  ↳', chunks[i]));
  return out;
}
function sep() {
  return `├${'─'.repeat(W - 2)}┤`;
}

function textReceipt(stats, chainOk) {
  const lines = [];
  const title = '⬢  M A Y D A Y   R E C E I P T';
  lines.push('');
  lines.push(`${CYAN}${BOLD}${title.padStart(Math.floor((W + title.length) / 2))}${RESET}`);
  lines.push(`┌${'─'.repeat(W - 2)}┐`);
  lines.push(...rowsFor('session', stats.name));
  lines.push(...rowsFor('command', stats.command));
  if (stats.adapter && stats.adapter !== 'wrap') {
    lines.push(row('recorded via', stats.adapter === 'claude-code' ? 'claude code hooks' : stats.adapter === 'mcp' ? 'mcp wire tap' : stats.adapter));
  }
  lines.push(row('started', stats.started ? stats.started.toISOString().replace('T', ' ').slice(0, 19) : '?'));
  lines.push(row('duration', fmtDuration(stats.durationMs)));
  lines.push(row('exit code', stats.exitCode === 0 ? '0  (clean landing)' : stats.exitCode == null ? '?' : `${stats.exitCode}  (see tape)`));
  lines.push(sep());

  const toolN = stats.tools.length;
  const cmdN = stats.commands.length;
  lines.push(row('tool calls', String(toolN)));
  if (stats.toolErrors) lines.push(row('tool errors', `${RED}${String(stats.toolErrors)}${RESET}`));
  if (stats.turns) lines.push(row('agent turns', String(stats.turns)));
  for (const t of stats.tools.slice(0, 4)) lines.push(row(`  · ${t.slice(0, 20)}`, ''));
  if (toolN > 4) lines.push(row(`  … +${toolN - 4} more`, ''));
  lines.push(row('shell commands', String(cmdN)));
  for (const c of stats.commands.slice(0, 3)) lines.push(row(`  · ${c.slice(0, 20)}`, ''));
  if (cmdN > 3) lines.push(row(`  … +${cmdN - 3} more`, ''));

  const touched = stats.files.length;
  const writes = stats.files.filter((f) => f.ops.some((o) => /wrote|created|overwrote/i.test(o))).length;
  const edits = stats.files.filter((f) => f.ops.some((o) => /edited|modified|renamed/i.test(o))).length;
  const dels = stats.files.filter((f) => f.ops.some((o) => /deleted|removed/i.test(o))).length;
  lines.push(row('files touched', `${touched}${writes ? ` · ${writes} written` : ''}${edits ? ` · ${edits} edited` : ''}${dels ? ` · ${RED}${dels} deleted${RESET}` : ''}`));
  for (const f of stats.files.slice(0, 4)) lines.push(row(`  · ${f.path.slice(0, 20)}`, f.ops.join(', ').slice(0, 20)));
  if (touched > 4) lines.push(row(`  … +${touched - 4} more`, ''));

  lines.push(row('urls hit', String(stats.urls.length)));
  lines.push(row('output volume', `${fmtBytes(stats.outputBytes)} across ${stats.byType.out || 0} lines`));
  lines.push(row('stderr lines', String(stats.stderrLines)));
  lines.push(row('humans consulted', stats.humansConsulted ? '1  (kept in the loop)' : '0  (unsupervised flight)'));
  lines.push(sep());
  lines.push(row('events recorded', String(stats.events)));
  lines.push(row('tamper chain', chainOk ? `${GREEN}sha256 · intact${RESET}` : `${RED}BROKEN${RESET}`));
  lines.push(`└${'─'.repeat(W - 2)}┘`);
  lines.push(`${ORANGE}${verdict(stats)}${RESET}`);
  lines.push('');
  return lines.join('\n');
}

function markdownReceipt(stats, chainOk) {
  const L = [];
  L.push(`## ⬢ AGENTBOX flight receipt — \`${stats.name}\``);
  L.push('');
  L.push(`> ${verdict(stats)}`);
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| **command** | \`${stats.command}\` |`);
  L.push(`| **started** | ${stats.started ? stats.started.toISOString() : '?'} |`);
  L.push(`| **duration** | ${fmtDuration(stats.durationMs)} |`);
  L.push(`| **exit code** | ${stats.exitCode == null ? '?' : stats.exitCode} |`);
  L.push(`| **tool calls** | ${stats.tools.length} |`);
  L.push(`| **shell commands** | ${stats.commands.length} |`);
  L.push(`| **files touched** | ${stats.files.length}${stats.files.some((f) => f.ops.some((o) => /deleted|removed/i.test(o))) ? ' ⚠️ incl. deletions' : ''} |`);
  L.push(`| **urls hit** | ${stats.urls.length} |`);
  L.push(`| **humans consulted** | ${stats.humansConsulted} |`);
  L.push(`| **events** | ${stats.events} (${fmtBytes(stats.outputBytes)} of output) |`);
  L.push(`| **tamper chain** | ${chainOk ? '✅ sha256 intact' : '❌ BROKEN'} |`);
  if (stats.humansConsulted) {
    L.push('');
    L.push('<details><summary>Prompts (the human did say things)</summary>');
    L.push('');
    for (const p of stats.prompts.slice(0, 10)) L.push(`- “${p.replace(/`/g, "'").slice(0, 120)}”`);
    L.push('');
    L.push('</details>');
  }
  if (stats.files.length) {
    L.push('');
    L.push('<details><summary>Files touched</summary>');
    L.push('');
    for (const f of stats.files.slice(0, 20)) L.push(`- \`${f.path}\` — ${f.ops.join(', ')}`);
    L.push('');
    L.push('</details>');
  }
  if (stats.tools.length) {
    L.push('');
    L.push('<details><summary>Tool calls</summary>');
    L.push('');
    for (const t of stats.tools.slice(0, 20)) L.push(`- \`${t.replace(/`/g, "'")}\``);
    L.push('');
    L.push('</details>');
  }
  return L.join('\n');
}

function jsonReceipt(stats, chainOk, file) {
  return JSON.stringify({ file, chainOk, ...stats, started: stats.started ? stats.started.toISOString() : null }, null, 2);
}

/**
 * Print/render a receipt for a session file.
 * opts: { format: 'text'|'markdown'|'json', force }
 * Returns { ok, stats, chainOk }.
 */
function receipt(file, opts = {}) {
  const res = verifyChain(file);
  const chainOk = res.ok;
  if (!res.ok && !opts.force) {
    process.stderr.write(`\x1b[31m⬢ agentbox: chain verification FAILED — ${res.reason}\x1b[0m\n`);
    process.exitCode = 1;
    return { ok: false, chainOk, stats: null };
  }
  const stats = summarize(res.events);
  const format = opts.format || 'text';
  if (format === 'json') process.stdout.write(jsonReceipt(stats, chainOk, file) + '\n');
  else if (format === 'markdown' || format === 'md') process.stdout.write(markdownReceipt(stats, chainOk) + '\n');
  else process.stdout.write(textReceipt(stats, chainOk) + '\n');
  return { ok: true, chainOk, stats };
}

module.exports = { receipt, textReceipt, markdownReceipt };

'use strict';
/**
 * agentbox — parse.js
 * Zero-magic heuristics that classify agent output lines and build a
 * session summary. Bring-your-own-parser later; these rules ship on by
 * default and intentionally err on the side of "plain".
 */

// ANSI escape sequences (colors etc.) — stripped before classification
const ANSI_RE = /\x1b(?:\[[?0-9;:><]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[P^_].*?\x1b\\)/g;

function stripAnsi(s) {
  return String(s || '').replace(ANSI_RE, '');
}

// A shell-ish command at line start (with or without $ / > prompt)
const CMD_RE = /^\s*(?:\$\s*|>\s*)?((?:sudo\s+)?(?:npm|npx|pnpm|yarn|bun|pip3?|python3?|node|deno|git|cargo|go|make|cmake|docker|kubectl|helm|brew|apt(?:-get)?|curl|wget|ssh|scp|rsync|terraform|aws|gcloud|gh|pytest|rails|ls|cp|mv|rm|mkdir|touch|chmod|chown|cat|sed|awk|grep)\b.+)$/i;

// Explicit tool-call convention: [TOOL] name("args")  — agents can adopt it
const TOOL_RE = /^\[(?:TOOL|tool|Tool)\]\s*(.+)$/;

// File writes/edits/deletes mentioned in prose or tool output
const FILEOP_RE = /\b(wrote|created|edited|deleted|removed|modified|renamed|overwrote)\b\s+(?:the\s+)?(?:file\s+)?([\w./~\\-]+\.[A-Za-z0-9]{1,10})/i;
const FILE_GROUP_RE = /\b(wrote|created|edited|deleted|removed|modified|renamed|overwrote)\b\s+\d+\s+files?\b/i;
const FILE_GROUP_ITEM_RE = /[└├]\s*([\w./~\\-]+\.[A-Za-z0-9]{1,10})\s*\(/;

// File ops embedded in tool calls, e.g. write(src/deploy.sh — 42 lines)
const TOOL_FILE_RE = /\b(write|edit|create|delete|remove|overwrite|patch|update)\s*\(\s*[\"']?([\w./~\\-]+\.[A-Za-z0-9]{1,10})\b/i;
const VERB_MAP = { write: 'wrote', edit: 'edited', patch: 'edited', update: 'edited', create: 'created', delete: 'deleted', remove: 'removed', overwrite: 'overwrote' };

// Structured tool names (from the hook/MCP adapters) → file op, for receipts
const TOOLNAME_OP_MAP = {
  Write: 'wrote', Edit: 'edited', MultiEdit: 'edited', NotebookEdit: 'edited',
  Delete: 'removed', Remove: 'removed', Move: 'renamed', Rename: 'renamed',
};
function opForToolName(name) {
  return TOOLNAME_OP_MAP[name] || 'touched';
}

/**
 * Short, human preview of a tool input: known primary fields read better
 * than raw JSON. Bash({command:'ls'}) → 'ls'; Write({file_path}) → the path.
 */
function inputPreview(input, cap = 120) {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, cap);
  if (typeof input === 'object') {
    const primary = input.command || input.file_path || input.notebook_path || input.path
      || input.url || input.query || input.pattern || input.text;
    if (primary != null) return String(primary).slice(0, cap);
  }
  try { return JSON.stringify(input).slice(0, cap); } catch { return String(input).slice(0, cap); }
}

/** One-line label for a structured tool call: Bash(git status --short) */
function toolCallLabel(name, input) {
  const preview = inputPreview(input, 120);
  return `${name || 'tool'}${preview ? `(${preview})` : ''}`.slice(0, 200);
}

// URLs hit (network activity)
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/;

/** Classify one line of output. Priority: tool > cmd > file > net > plain. */
function classifyLine(line) {
  const clean = stripAnsi(line);
  if (!clean || !clean.trim()) return { kind: 'plain' };
  const tool = clean.match(TOOL_RE);
  if (tool) {
    return { kind: 'tool', detail: tool[1].trim().slice(0, 200) };
  }
  const cmd = clean.match(CMD_RE);
  if (cmd) {
    return { kind: 'cmd', detail: cmd[1].trim().slice(0, 200) };
  }
  const file = clean.match(FILEOP_RE);
  if (file) {
    return { kind: 'file', detail: { op: file[1].toLowerCase(), path: file[2] } };
  }
  const url = clean.match(URL_RE);
  if (url) {
    return { kind: 'net', detail: url[0].slice(0, 200) };
  }
  return { kind: 'plain' };
}

/**
 * Build a human summary from a verified event list.
 * Event types produced by wrap():
 *   meta  {cmd, argv, cwd, user, host, platform, node, agentbox, name, adapter?}
 *   out   {stream: 'stdout'|'stderr', kind, text?|detail?}
 *   in    {text}
 *   exit  {code, durationMs}
 *   signal{signal}
 * Event types produced by the adapters (claude hooks / mcp wire tap):
 *   tool_call    {phase:'start'|'end', name, input?, status?, durationMs?, source, id?}
 *   prompt       {text, source}
 *   notification {message}
 *   turn_end     {}
 *   mcp_msg      {dir:'C2S'|'S2C', method, id, preview}
 *   note         {message}
 */
function summarize(events) {
  const meta = events.find((e) => e.type === 'meta');
  const exit = [...events].reverse().find((e) => e.type === 'exit');
  const startT = events.length ? events[0].t : 0;
  const endT = events.length ? events[events.length - 1].t : 0;

  const stats = {
    name: (meta && meta.data && meta.data.name) || 'session',
    command: meta ? meta.data.cmd : '?',
    cwd: meta ? meta.data.cwd : '?',
    user: meta ? meta.data.user : '?',
    adapter: (meta && meta.data && meta.data.adapter) || 'wrap',
    started: startT ? new Date(startT) : null,
    durationMs: exit && exit.data && exit.data.durationMs != null ? exit.data.durationMs : Math.max(0, endT - startT),
    exitCode: exit && exit.data ? exit.data.code : null,
    events: events.length,
    byType: {},
    byKind: {},
    outputBytes: 0,
    stderrLines: 0,
    commands: [],
    tools: [],
    files: [],        // { op, path }
    urls: [],
    stdinEvents: 0,
    humansConsulted: 0,
    signals: [],
    prompts: [],      // structured prompts (hook adapter)
    turns: 0,         // agent turn boundaries (Stop hooks)
    notifications: 0,
    mcpMessages: 0,
    toolCallStarts: 0,
    toolCallEnds: 0,
    toolErrors: 0,
  };
  const endOnlyNames = [];
  let groupedFileOp = null;
  let groupedFileUntil = 0;

  for (const ev of events) {
    stats.byType[ev.type] = (stats.byType[ev.type] || 0) + 1;
    if (ev.type === 'out') {
      const d = ev.data || {};
      const kind = d.kind || 'plain';
      const clean = stripAnsi(d.text || '');
      stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
      if (d.stream === 'stderr') stats.stderrLines += 1;
      stats.outputBytes += Buffer.byteLength(String(d.text != null ? d.text : (d.detail || '')), 'utf8');
      if (kind === 'cmd') {
        const m = clean.match(CMD_RE);
        stats.commands.push(m ? m[1].trim() : clean);
      }
      if (kind === 'tool') {
        const m = clean.match(TOOL_RE);
        const toolDetail = m ? m[1].trim() : (d.detail || clean);
        stats.tools.push(toolDetail);
        // file ops hidden inside tool calls: write(src/deploy.sh — …)
        const tf = toolDetail.match(TOOL_FILE_RE);
        if (tf) stats.files.push({ op: VERB_MAP[tf[1].toLowerCase()] || tf[1].toLowerCase(), path: tf[2] });
      }
      if (kind === 'file') {
        const detail = d.detail && d.detail.path ? d.detail : classifyLine(d.text || '').detail;
        if (detail && detail.path) stats.files.push({ op: detail.op, path: detail.path });
      }
      const group = clean.match(FILE_GROUP_RE);
      if (group) {
        groupedFileOp = group[1].toLowerCase();
        groupedFileUntil = ev.t + 10000;
      } else if (ev.t > groupedFileUntil) {
        groupedFileOp = null;
      }
      const groupItem = groupedFileOp && clean.match(FILE_GROUP_ITEM_RE);
      if (groupItem) stats.files.push({ op: groupedFileOp, path: groupItem[1] });
      // URLs observed anywhere in output (stripped of ANSI)
      const scan = stripAnsi([typeof d.detail === 'string' ? d.detail : '', typeof d.text === 'string' ? d.text : ''].join(' '));
      const u = scan.match(URL_RE);
      if (u) stats.urls.push(u[0]);
    } else if (ev.type === 'in') {
      stats.stdinEvents += 1;
    } else if (ev.type === 'signal') {
      stats.signals.push(ev.data && ev.data.signal);
    } else if (ev.type === 'tool_call') {
      // structured tool calls from the claude-code hook / mcp adapters
      const d = ev.data || {};
      if (d.phase === 'end') {
        stats.toolCallEnds += 1;
        if (d.status === 'error') stats.toolErrors += 1;
        endOnlyNames.push(String(d.name || 'tool'));
      } else {
        stats.toolCallStarts += 1;
        stats.tools.push(toolCallLabel(d.name, d.input));
        if (d.input && typeof d.input === 'object') {
          const p = d.input.file_path || d.input.notebook_path || d.input.path;
          if (p) stats.files.push({ op: opForToolName(String(d.name || '')), path: String(p) });
          if (d.input.command) stats.commands.push(String(d.input.command).slice(0, 200));
          if (d.input.url) stats.urls.push(String(d.input.url).slice(0, 200));
        }
      }
    } else if (ev.type === 'prompt') {
      stats.stdinEvents += 1;
      if (ev.data && ev.data.text) stats.prompts.push(String(ev.data.text).slice(0, 200));
    } else if (ev.type === 'turn_end') {
      stats.turns += 1;
    } else if (ev.type === 'notification') {
      stats.notifications += 1;
    } else if (ev.type === 'mcp_msg') {
      stats.mcpMessages += 1;
    }
  }

  // session joined mid-flight (hooks added after start): no PreToolUse starts,
  // only PostToolUse ends — still name the tools from the ends
  if (stats.toolCallStarts === 0 && endOnlyNames.length) {
    stats.tools.push(...endOnlyNames.map((n) => `${n} ()`));
  }

  stats.humansConsulted = stats.stdinEvents > 0 || stats.prompts.length > 0 ? 1 : 0;

  // de-dup helpers
  const uniq = (arr) => [...new Set(arr)];
  stats.commands = uniq(stats.commands);
  stats.tools = uniq(stats.tools);
  stats.urls = uniq(stats.urls);

  // collapse file ops per path
  const fileMap = new Map();
  for (const f of stats.files) {
    const cur = fileMap.get(f.path) || new Set();
    cur.add(f.op);
    fileMap.set(f.path, cur);
  }
  stats.files = [...fileMap.entries()].map(([p, ops]) => ({ path: p, ops: [...ops] }));

  return stats;
}

function fmtDuration(ms) {
  if (ms == null) return '?';
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} kB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/** A deadpan one-liner verdict, receipt style. */
function verdict(stats) {
  const deleted = stats.files.filter((f) => f.ops.some((o) => o === 'deleted' || o === 'removed'));
  if (stats.signals.includes('SIGINT')) return 'flight interrupted mid-air. black box recovered.';
  if (stats.toolErrors > 0) return `${stats.toolErrors} tool call${stats.toolErrors > 1 ? 's' : ''} went sideways. tape tells you which.`;
  if (stats.exitCode !== 0 && stats.exitCode != null) return 'agentbox received. wreckage mapped below.';
  if (deleted.length > 0) return `${deleted.length} file${deleted.length > 1 ? 's' : ''} deleted. hope ${deleted.length > 1 ? 'they were' : 'it was'} not load-bearing.`;
  if (stats.humansConsulted === 0 && stats.events > 20) return 'smooth flight. zero supervision. as requested.';
  if (stats.exitCode === 0) return 'uneventful flight. the best kind.';
  return 'black box recovered. details below.';
}

module.exports = { classifyLine, summarize, fmtDuration, fmtBytes, verdict, stripAnsi, toolCallLabel, inputPreview, opForToolName, CMD_RE, TOOL_RE, FILEOP_RE, FILE_GROUP_RE, FILE_GROUP_ITEM_RE, TOOL_FILE_RE, URL_RE };

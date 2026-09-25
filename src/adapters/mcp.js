'use strict';
/**
 * agentbox — adapters/mcp.js
 * The MCP wire tap: run any MCP server behind a recording proxy.
 *
 *   agentbox mcp -- npx -y @modelcontextprotocol/server-everything
 *
 * Point your MCP client (Claude Desktop, Cursor, Claude Code, any harness)
 * at agentbox instead of the server. Agentbox spawns the real server, forwards
 * every JSON-RPC message verbatim, and writes a hash-chained tape of:
 *
 *   mcp_msg   every message, both directions (method + id + preview)
 *   tool_call every tools/call — start (name + arguments) and end
 *             (ok/error + duration + result preview), paired by request id
 *   note      initialize handshake (server name/version/protocol)
 *
 * MCP stdio transport is newline-delimited JSON — the proxy is a line pump.
 * Unknown bytes still get forwarded untouched; the tape never blocks a flight.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Recorder, newSessionFile, VERSION } = require('../chain');

function trunc(s, n) {
  const str = s == null ? '' : String(s);
  return str.length <= n ? str : `${str.slice(0, n)}…`;
}

/** Keep small JSON values intact; stringify+truncate anything chunky. */
function slim(v, cap) {
  if (v == null) return null;
  if (typeof v === 'string') return trunc(v, cap);
  try {
    const j = JSON.stringify(v);
    if (j.length <= cap) return v;
    return trunc(j, cap);
  } catch { return trunc(String(v), cap); }
}

function requestKey(id) {
  if (id === undefined) return null;
  return `${typeof id}:${String(id)}`;
}

function responseStatus(msg) {
  return msg && (msg.error != null || (msg.result && msg.result.isError)) ? 'error' : 'ok';
}

/** Split a byte stream into complete lines (MCP stdio = 1 JSON-RPC msg/line). */
class LineSplitter {
  constructor(onLine, onFlush) {
    this.parts = [];
    this.length = 0;
    this.onLine = onLine;
    this.onFlush = onFlush;
  }

  push(chunk) {
    const data = chunk.toString('utf8');
    let start = 0;
    let idx;
    while ((idx = data.indexOf('\n', start)) !== -1) {
      const part = data.slice(start, idx);
      const line = (this.parts.length ? this.parts.join('') + part : part).replace(/\r$/, '');
      this.parts = [];
      this.length = 0;
      if (line) this.onLine(line);
      start = idx + 1;
    }
    if (start < data.length) {
      const rest = data.slice(start);
      this.parts.push(rest);
      this.length += rest.length;
    }
  }

  flush() {
    if (this.length) {
      const rest = this.parts.join('');
      if (rest.trim() && this.onFlush) this.onFlush(rest.replace(/\r$/, ''));
      this.parts = [];
      this.length = 0;
    }
  }
}

/**
 * Run the proxy. `serverArgs` is the real MCP server command line.
 * opts: { name, cwd, quiet, file }
 * Returns a promise: { file, exitCode }.
 */
function runMcpProxy(serverArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(serverArgs) || serverArgs.length === 0) {
      reject(new Error('mcp: no server command — usage: agentbox mcp -- <server command> [args…]'));
      return;
    }
    const name = opts.name || `${path.basename(serverArgs[0])}-mcp`;
    const file = opts.file || newSessionFile(opts.cwd || process.cwd(), name);
    const rec = new Recorder(file, {
      name,
      cmd: `mcp ⇄ ${serverArgs.join(' ')}`,
      argv: serverArgs,
      adapter: 'mcp',
      cwd: process.cwd(),
      user: os.userInfo().username,
      host: os.hostname(),
      platform: `${process.platform} ${process.arch}`,
      agentbox: VERSION,
      pid: process.pid,
    });

    if (!opts.quiet) {
      const DIM = '\x1b[2m'; const CYAN = '\x1b[36m'; const BOLD = '\x1b[1m'; const RESET = '\x1b[0m';
      process.stderr.write(`${DIM}${CYAN}⬢ agentbox${RESET}${DIM}: MCP wire tap on → ${file}${RESET}\n`);
      process.stderr.write(`${DIM}  point your MCP client at agentbox; server: ${serverArgs.join(' ')}${RESET}\n`);
    }

    const child = spawn(serverArgs[0], serverArgs.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGENTBOX: '1', AGENTBOX_SESSION: file },
      cwd: opts.cwd || process.cwd(),
    });

    const pending = new Map(); // request id (string) → { name, t0 }
    const t0 = Date.now();
    let serverName = null;
    let serverVersion = null;
    let calls = 0;
    let done = false;
    let anonSeq = 0;

    const clientSplit = new LineSplitter(onClientLine, (raw) => forwardToServer(raw));
    const serverSplit = new LineSplitter(onServerLine, (raw) => forwardToClient(raw));

    function finalize(code, signal) {
      if (done) return;
      done = true;
      clientSplit.flush();
      serverSplit.flush();
      rec.append('exit', {
        code: code == null ? (signal ? -1 : 0) : code,
        durationMs: Date.now() - t0,
        signal: signal || undefined,
        server: serverName,
        unansweredCalls: pending.size,
        toolCalls: calls,
      });
      rec.close();
      if (!opts.quiet) {
        const DIM = '\x1b[2m'; const CYAN = '\x1b[36m'; const RESET = '\x1b[0m';
        process.stderr.write(`${DIM}${CYAN}⬢ agentbox${RESET}${DIM}: ${rec.i} events recorded · ${calls} tool calls · try: agentbox receipt${RESET}\n`);
      }
      resolve({ file, exitCode: code == null ? 0 : code });
    }

    function forwardToServer(line) {
      if (child.stdin && child.stdin.writable) child.stdin.write(`${line}\n`);
    }
    function forwardToClient(line) {
      process.stdout.write(`${line}\n`);
    }

    /** client (agent) → agentbox → real server */
    function onClientLine(line) {
      let msg = null;
      try { msg = JSON.parse(line); } catch { /* not JSON — still forwarded verbatim */ }
      if (msg && typeof msg === 'object') {
        rec.append('mcp_msg', {
          dir: 'C2S',
          method: msg.method || null,
          id: msg.id === undefined ? null : msg.id,
          preview: trunc(line, 400),
        });
        const key = msg.id === undefined ? `anon:${++anonSeq}` : requestKey(msg.id);
        if (msg.method === 'tools/call' && msg.params) {
          calls += 1;
          rec.append('tool_call', {
            phase: 'start',
            name: String(msg.params.name || 'unknown'),
            input: slim(msg.params.arguments, 2000),
            source: 'mcp',
            id: msg.id === undefined ? null : msg.id,
          });
          pending.set(key, { name: String(msg.params.name || 'unknown'), t0: Date.now() });
        } else if (msg.method === 'initialize') {
          rec.append('note', { message: `client initialize · protocol ${msg.params && msg.params.protocolVersion ? msg.params.protocolVersion : '?'}` });
        }
      }
      forwardToServer(line);
    }

    /** real server → agentbox → client */
    function onServerLine(line) {
      let msg = null;
      try { msg = JSON.parse(line); } catch { /* pass through untouched */ }
      if (msg && typeof msg === 'object') {
        rec.append('mcp_msg', {
          dir: 'S2C',
          method: msg.method || null,
          id: msg.id === undefined ? null : msg.id,
          preview: trunc(line, 400),
        });
        const key = requestKey(msg.id);
        if (pending.has(key)) {
          const p = pending.get(key);
          pending.delete(key);
          const result = msg.result || {};
          const rpcError = msg.error != null;
          rec.append('tool_call', {
            phase: 'end',
            name: p.name,
            source: 'mcp',
            status: responseStatus(msg),
            durationMs: Date.now() - p.t0,
            preview: slim(rpcError ? msg.error : (result.content !== undefined ? result.content : result), 500),
            id: msg.id === undefined ? null : msg.id,
          });
        }
        if (msg.result && msg.result.serverInfo) {
          serverName = (msg.result.serverInfo && msg.result.serverInfo.name) || null;
          serverVersion = (msg.result.serverInfo && msg.result.serverInfo.version) || null;
          rec.append('note', { message: `server: ${serverName || '?'}${serverVersion ? ` v${serverVersion}` : ''} · protocol ${msg.result.protocolVersion || '?'}` });
        }
      }
      forwardToClient(line);
    }

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => clientSplit.push(c));
    process.stdin.on('end', () => { try { child.stdin.end(); } catch { /* gone */ } });
    process.stdin.on('error', () => { /* client vanished; server close will finalize */ });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => serverSplit.push(c));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      process.stderr.write(c); // server logs stay visible — transparency first
      for (const line of String(c).split('\n')) {
        if (line.trim()) rec.append('out', { stream: 'stderr', kind: 'plain', text: trunc(line, 500) });
      }
    });

    child.on('error', (e) => {
      rec.append('out', { stream: 'stderr', kind: 'plain', text: `agentbox: failed to spawn MCP server: ${e.message}` });
      finalize(127);
    });
    child.on('close', (code, signal) => finalize(code, signal));

    const onSig = (signal) => {
      rec.append('signal', { signal, source: 'keyboard' });
      try { child.kill(signal); } catch { /* gone */ }
    };
    process.on('SIGINT', () => onSig('SIGINT'));
    process.on('SIGTERM', () => onSig('SIGTERM'));
  });
}

/**
 * `agentbox init mcp -- <server command>`
 * Print ready-to-paste MCP config blocks that route the server through agentbox.
 */
function initMcp(serverArgs, opts = {}) {
  if (!Array.isArray(serverArgs) || serverArgs.length === 0) {
    process.stderr.write('usage: agentbox init mcp -- <server command> [args…]\nexample: agentbox init mcp -- npx -y @modelcontextprotocol/server-everything\n');
    process.exitCode = 1;
    return;
  }
  const CYAN = '\x1b[36m'; const BOLD = '\x1b[2m'; const DIM = '\x1b[2m'; const RESET = '\x1b[0m';
  // identity: prefer the package/module arg (npx -y @scope/pkg, node path/server.js)
  // over the runner binary (npx/node) so config keys are meaningful
  let serverName = path.basename(serverArgs[0]).replace(/[^\w.-]+/g, '-');
  for (let i = 1; i < serverArgs.length; i++) {
    const a = String(serverArgs[i]);
    if (a.startsWith('-')) continue; // flags (and values we can skip cheaply)
    if (a.startsWith('@') || a.includes('/') || a.endsWith('.js')) {
      serverName = a.replace(/^@/, '').replace(/[^\w.-]+/g, '-');
      break;
    }
  }
  const displayCmd = `agentbox mcp -- ${serverArgs.join(' ')}`;

  process.stdout.write(`${CYAN}${BOLD}⬢ agentbox${RESET}: MCP wire tap — route ${DIM}${serverArgs.join(' ')}${RESET} through agentbox\n\n`);
  process.stdout.write(`  every ${BOLD}tools/call${RESET} (arguments, results, duration) lands on a tamper-evident tape\n\n`);

  const block = (title, file, json) => {
    process.stdout.write(`  ${BOLD}${title}${RESET} ${DIM}${file}${RESET}\n    ${json.replace(/\n/g, '\n    ')}\n\n`);
  };

  block('Claude Code (project)', '.mcp.json', JSON.stringify({
    mcpServers: { [serverName]: { command: 'agentbox', args: ['mcp', '--', ...serverArgs] } },
  }, null, 2));

  block('Claude Desktop', 'claude_desktop_config.json', JSON.stringify({
    mcpServers: { [serverName]: { command: 'agentbox', args: ['mcp', '--', ...serverArgs] } },
  }, null, 2));

  block('Cursor', '~/.cursor/mcp.json', JSON.stringify({
    mcpServers: { [serverName]: { command: 'agentbox', args: ['mcp', '--', ...serverArgs] } },
  }, null, 2));

  process.stdout.write(`  ${DIM}alias: ${displayCmd}\n  agentbox must be on PATH (npm i -g agentbox-cli) or replace "agentbox"\n  with \`node <path>/bin/agentbox.js\`. restart the client to pick it up.${RESET}\n`);
}

module.exports = { runMcpProxy, initMcp, LineSplitter, requestKey, responseStatus };

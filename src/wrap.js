'use strict';
/**
 * agentbox — wrap.js
 * `agentbox wrap -- <command>` : spawn the command with the black box on.
 * Streams stdout/stderr through live (so the human still sees everything)
 * while recording line-by-line, classified events into the hash chain.
 * 100% local. No SDK changes needed in the wrapped program.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Recorder, newSessionFile, VERSION } = require('./chain');
const { classifyLine } = require('./parse');

const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const MAX_PARTIAL_LINE = 1024 * 1024;

function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, `'"'"'`)}'`;
}

/**
 * Interactive terminal programs (Codex, vim, etc.) must see a real TTY.
 * util-linux `script` supplies a PTY while still letting us capture its output.
 */
function spawnSpec(commandArgs, usePty, terminalSize = {}) {
  if (!usePty) return { command: commandArgs[0], args: commandArgs.slice(1) };

  const rows = Number.isInteger(terminalSize.rows) && terminalSize.rows > 0 ? terminalSize.rows : 24;
  const columns = Number.isInteger(terminalSize.columns) && terminalSize.columns > 0 ? terminalSize.columns : 80;
  if (process.platform === 'darwin' || process.platform.endsWith('bsd')) {
    const command = `stty rows ${rows} columns ${columns} 2>/dev/null; exec ${commandArgs.map(shellQuote).join(' ')}`;
    return { command: 'script', args: ['-q', '/dev/null', 'sh', '-c', command] };
  }

  // `script` writes to our capture pipe, so it cannot infer geometry from its
  // own stdout. Set the newly allocated slave PTY before starting the command.
  const command = `stty rows ${rows} cols ${columns} 2>/dev/null; exec ${commandArgs.map(shellQuote).join(' ')}`;
  return { command: 'script', args: ['-qefc', command, '/dev/null'] };
}

function resizeChildPty(pid, terminalSize) {
  if (process.platform !== 'linux' || !pid) return false;
  const rows = Number(terminalSize.rows);
  const columns = Number(terminalSize.columns);
  if (!(rows > 0 && columns > 0)) return false;
  try {
    let current = pid;
    // `script` starts a shell which execs the requested command.
    for (let depth = 0; depth < 3; depth++) {
      const children = fs.readFileSync(`/proc/${current}/task/${current}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
      if (!children.length) break;
      current = Number(children[0]);
    }
    const ttyFd = `/proc/${current}/fd/0`;
    const resize = spawn('stty', ['-F', ttyFd, 'rows', String(rows), 'cols', String(columns)], {
      stdio: 'ignore',
    });
    resize.on('error', () => {});
    try { process.kill(current, 'SIGWINCH'); } catch { /* child may have exited */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * Line-buffered recorder around a raw stream.
 * Emits one event per complete line (kind classified), flushes the
 * trailing partial line on close.
 */
class LineRecorder {
  constructor(recorder, stream) {
    this.rec = recorder;
    this.stream = stream;
    this.parts = [];
    this.length = 0;
  }

  push(chunk) {
    const data = String(chunk);
    let start = 0;
    let idx;
    while ((idx = data.indexOf('\n', start)) !== -1) {
      const part = data.slice(start, idx);
      const line = this.parts.length ? this.parts.join('') + part : part;
      this.parts = [];
      this.length = 0;
      this.emit(line);
      start = idx + 1;
    }
    if (start < data.length) {
      const rest = data.slice(start);
      this.parts.push(rest);
      this.length += rest.length;
      if (this.length >= MAX_PARTIAL_LINE) {
        this.emit(this.parts.join(''));
        this.parts = [];
        this.length = 0;
      }
    }
  }

  emit(line) {
    // strip trailing \r (windows / progress bars)
    const text = line.replace(/\r$/, '');
    const { kind, detail } = classifyLine(text);
    const data = { stream: this.stream, kind, text };
    if (detail !== undefined) data.detail = detail;
    this.rec.append('out', data);
  }

  flush() {
    if (this.length) {
      this.emit(this.parts.join(''));
      this.parts = [];
      this.length = 0;
    }
  }
}

/**
 * Record `commandArgs` (array) into a new session file.
 * opts: { name, cwd, quiet, dir }
 * Returns { file, exitCode, events } via callback or promise.
 */
function wrap(commandArgs, opts = {}) {
  return new Promise((resolve) => {
    if (!commandArgs || commandArgs.length === 0) {
      throw new Error('wrap: nothing to record — pass a command after `--`');
    }
    const name = opts.name || path.basename(commandArgs[0]);
    const file = opts.file || newSessionFile(opts.cwd || process.cwd(), name);
    const rec = new Recorder(file, {
      name,
      cmd: commandArgs.join(' '),
      argv: commandArgs,
      cwd: process.cwd(),
      user: os.userInfo().username,
      host: os.hostname(),
      platform: `${os.platform()} ${os.arch()}`,
      node: process.version,
      agentbox: VERSION,
      pid: process.pid,
    });

    if (!opts.quiet) {
      process.stderr.write(`${DIM}${CYAN}⬢ agentbox${RESET}${DIM}: black box on → recording to ${file}${RESET}\n`);
    }

    const usePty = opts.pty === true || (opts.pty !== false && process.stdin.isTTY && process.platform !== 'win32');
    const terminalSize = opts.terminalSize || {
      columns: process.stdout.columns || process.stderr.columns,
      rows: process.stdout.rows || process.stderr.rows,
    };
    const spec = spawnSpec(commandArgs, usePty, terminalSize);
    const child = spawn(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AGENTBOX: '1',
        AGENTBOX_SESSION: file,
        ...(usePty ? { COLUMNS: String(terminalSize.columns || 80), LINES: String(terminalSize.rows || 24) } : {}),
      },
      cwd: opts.cwd || process.cwd(),
      detached: process.platform !== 'win32',
    });

    const outR = new LineRecorder(rec, 'stdout');
    const errR = new LineRecorder(rec, 'stderr');
    const t0 = Date.now();
    let done = false;
    let requestedSignal = null;
    let killTimer = null;
    const killChild = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* gone */ }
    };
    const forwardSignal = (signal) => {
      if (done) return;
      requestedSignal = signal;
      rec.append('signal', { signal, source: 'parent' });
      killChild(signal);
      clearTimeout(killTimer);
      killTimer = setTimeout(() => killChild('SIGKILL'), 2000);
      killTimer.unref();
    };
    const onSigint = () => forwardSignal('SIGINT');
    const onSigterm = () => forwardSignal('SIGTERM');
    const onSighup = () => forwardSignal('SIGHUP');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    process.on('SIGHUP', onSighup);
    const onResize = () => resizeChildPty(child.pid, {
      columns: process.stdout.columns || process.stderr.columns,
      rows: process.stdout.rows || process.stderr.rows,
    });
    if (usePty) process.stdout.on('resize', onResize);

    child.stdout.on('data', (c) => {
      const s = c.toString('utf8');
      outR.push(s);
      if (!opts.quiet && !process.stdout.write(c)) {
        child.stdout.pause();
        process.stdout.once('drain', () => child.stdout.resume());
      }
    });
    child.stderr.on('data', (c) => {
      const s = c.toString('utf8');
      errR.push(s);
      if (!opts.quiet && !process.stderr.write(c)) {
        child.stderr.pause();
        process.stderr.once('drain', () => child.stderr.resume());
      }
    });

    // stdin: forward + record (raw mode when TTY so we see every keystroke).
    // Non-TTY stdin is opt-in via AGENTBOX_PIPE_STDIN=1 — an open, silent pipe
    // would otherwise keep this process alive forever.
    //
    // Critical: always detach stdin on child close/error. Leaving a resumed
    // stdin listener is what made `agentbox demo` / `wrap` hang the parent
    // process after the agent exited (preflight, CI, scripts).
    let stdinAttached = false;
    const onStdinData = (d) => {
      const s = d.toString('utf8');
      const control = Math.min(...['\x03', '\x04'].map((c) => { const i = s.indexOf(c); return i < 0 ? Infinity : i; }));
      if (Number.isFinite(control) && control > 0 && child.stdin && child.stdin.writable) child.stdin.write(d.subarray(0, control));
      if (s.includes('\x03')) {
        rec.append('signal', { signal: 'SIGINT', source: 'keyboard' });
        requestedSignal = 'SIGINT';
        killChild('SIGINT');
        return;
      }
      if (s.includes('\x04')) {
        if (child.stdin) child.stdin.end();
        return;
      }
      if (child.stdin && child.stdin.writable) child.stdin.write(d);
      if (s.length <= 512) rec.append('in', { text: s.replace(/\n$/, '') });
    };

    function attachStdin() {
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(true); } catch { /* non-interactive */ }
        process.stdin.on('data', onStdinData);
        process.stdin.resume();
        stdinAttached = true;
      } else if (process.env.AGENTBOX_PIPE_STDIN === '1' && !process.stdin.readableEnded) {
        process.stdin.on('data', onStdinData);
        stdinAttached = true;
      }
    }

    function detachStdin() {
      if (!stdinAttached) return;
      try { process.stdin.removeListener('data', onStdinData); } catch { /* fine */ }
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch { /* fine */ }
      }
      try { process.stdin.pause(); } catch { /* fine */ }
      stdinAttached = false;
    }

    attachStdin();

    function finalize(code, signal, spawnError) {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGHUP', onSighup);
      process.stdout.removeListener('resize', onResize);
      detachStdin();
      if (spawnError) {
        rec.append('out', { stream: 'stderr', kind: 'plain', text: `agentbox: failed to spawn: ${spawnError.message}` });
      }
      outR.flush(); errR.flush();
      const durationMs = Date.now() - t0;
      const finalCode = requestedSignal && code === 0 ? (requestedSignal === 'SIGINT' ? 130 : 143) : code;
      rec.append('exit', {
        code: finalCode,
        durationMs,
        signal: signal || undefined,
        spawnError: spawnError ? spawnError.message : undefined,
      });
      rec.close();
      if (!opts.quiet) {
        process.stderr.write(`${DIM}${CYAN}⬢ agentbox${RESET}${DIM}: ${rec.i} events recorded · ${durationMs} ms · try: agentbox receipt${RESET}\n`);
      }
      resolve({ file, exitCode: finalCode, events: rec.i });
    }

    child.on('error', (e) => finalize(127, null, e));

    child.on('close', (code, signal) => {
      finalize(code == null ? (signal ? -1 : 1) : code, signal);
    });
  });
}

module.exports = { wrap, LineRecorder, spawnSpec, resizeChildPty };

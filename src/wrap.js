'use strict';
/**
 * mayday — wrap.js
 * `mayday wrap -- <command>` : spawn the command with the black box on.
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

/**
 * Line-buffered recorder around a raw stream.
 * Emits one event per complete line (kind classified), flushes the
 * trailing partial line on close.
 */
class LineRecorder {
  constructor(recorder, stream) {
    this.rec = recorder;
    this.stream = stream;
    this.buf = '';
  }

  push(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      this.emit(line);
    }
  }

  emit(line) {
    // strip trailing \r (windows / progress bars)
    const text = line.replace(/\r$/, '');
    const { kind, detail } = classifyLine(text);
    const data = { stream: this.stream, kind, text };
    this.rec.append('out', data);
  }

  flush() {
    if (this.buf.length) {
      this.emit(this.buf);
      this.buf = '';
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
      mayday: VERSION,
      pid: process.pid,
    });

    if (!opts.quiet) {
      process.stderr.write(`${DIM}${CYAN}⬢ mayday${RESET}${DIM}: black box on → recording to ${file}${RESET}\n`);
    }

    const child = spawn(commandArgs[0], commandArgs.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MAYDAY: '1', MAYDAY_SESSION: file },
      cwd: opts.cwd || process.cwd(),
    });

    const outR = new LineRecorder(rec, 'stdout');
    const errR = new LineRecorder(rec, 'stderr');
    const t0 = Date.now();

    child.stdout.on('data', (c) => {
      const s = c.toString('utf8');
      outR.push(s);
      if (!opts.quiet) process.stdout.write(c);
    });
    child.stderr.on('data', (c) => {
      const s = c.toString('utf8');
      errR.push(s);
      if (!opts.quiet) process.stderr.write(c);
    });

    // stdin: forward + record (raw mode when TTY so we see every keystroke).
    // Non-TTY stdin is opt-in via MAYDAY_PIPE_STDIN=1 — an open, silent pipe
    // would otherwise keep this process alive forever.
    //
    // Critical: always detach stdin on child close/error. Leaving a resumed
    // stdin listener is what made `mayday demo` / `wrap` hang the parent
    // process after the agent exited (preflight, CI, scripts).
    let stdinAttached = false;
    const onStdinData = (d) => {
      const s = d.toString('utf8');
      if (s.includes('\x03')) {
        rec.append('signal', { signal: 'SIGINT', source: 'keyboard' });
        if (child.pid) { try { child.kill('SIGINT'); } catch { /* gone */ } }
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
      } else if (process.env.MAYDAY_PIPE_STDIN === '1' && !process.stdin.readableEnded) {
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

    child.on('error', (e) => {
      detachStdin();
      rec.append('out', { stream: 'stderr', kind: 'plain', text: `mayday: failed to spawn: ${e.message}` });
      outR.flush(); errR.flush();
      rec.append('exit', { code: 127, durationMs: Date.now() - t0, spawnError: e.message });
      rec.close();
      resolve({ file, exitCode: 127, events: rec.i });
    });

    child.on('close', (code, signal) => {
      detachStdin();
      outR.flush();
      errR.flush();
      const durationMs = Date.now() - t0;
      rec.append('exit', { code: code == null ? (signal ? -1 : 1) : code, durationMs, signal });
      rec.close();
      if (!opts.quiet) {
        process.stderr.write(`${DIM}${CYAN}⬢ mayday${RESET}${DIM}: ${rec.i} events recorded · ${durationMs} ms · try: mayday receipt${RESET}\n`);
      }
      resolve({ file, exitCode: code == null ? 1 : code, events: rec.i });
    });
  });
}

module.exports = { wrap, LineRecorder };

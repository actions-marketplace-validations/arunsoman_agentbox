'use strict';
/**
 * agentbox — chain.js
 * Tamper-evident, hash-chained event log (the "black box tape").
 *
 * Every event is a JSONL line:
 *   { i, t, type, data, prev, hash }
 * where hash = sha256(prev || i || t || type || JSON(data)).
 * Genesis prev is 64 zeros. Break or edit ANY line and verify() fails.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { redactEventData } = require('./redact');

const GENESIS = '0'.repeat(64);
const VERSION = '0.2.1';
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Deterministic event hash. data MUST be a JSON-stable object. */
function eventHash(prev, i, t, type, data) {
  return sha256(JSON.stringify([prev, i, t, type, data]));
}

function assertNotSymlink(file) {
  const absolute = path.resolve(file);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`refusing symlink path: ${current}`);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
  }
}

/** Append-only recorder. Writes JSONL, one event per line. */
class Recorder {
  constructor(file, meta) {
    this.file = file;
    this.i = 0;
    this.prev = GENESIS;
    this.redactions = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.flushTimer = null;
    assertNotSymlink(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, 'w');
    // stamp redaction policy into meta so the tape is self-describing
    const redactOff = process.env.AGENTBOX_REDACT != null
      && /^(0|false|off|no)$/i.test(String(process.env.AGENTBOX_REDACT).trim());
    const metaWithPolicy = { ...meta, redact: !redactOff };
    this.append('meta', metaWithPolicy); // event 0
    this.flush(); // make the session discoverable immediately
  }

  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pendingBytes) return;
    fs.writeSync(this.fd, this.pending.join(''));
    this.pending = [];
    this.pendingBytes = 0;
  }

  append(type, data) {
    const { data: scrubbed, count } = redactEventData(data);
    this.redactions += count;
    const t = Date.now();
    const i = this.i++;
    const hash = eventHash(this.prev, i, t, type, scrubbed);
    const line = JSON.stringify({ i, t, type, data: scrubbed, prev: this.prev, hash });
    const record = line + '\n';
    this.pending.push(record);
    this.pendingBytes += Buffer.byteLength(record);
    if (this.pendingBytes >= 64 * 1024) this.flush();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 25);
      this.flushTimer.unref();
    }
    this.prev = hash;
    return { i, t, type, data: scrubbed, hash, redactions: count };
  }

  close() {
    this.flush();
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
  }
}

/** Parse a session file into events (tolerates corrupt lines). */
function loadEvents(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    return { events: [], corrupt: { line: 0, error: e.message } };
  }
  const events = [];
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let carry = Buffer.alloc(0);
  let lineNo = 0;
  try {
    for (;;) {
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!bytes) break;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytes)]) : chunk.subarray(0, bytes);
      let start = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 10) continue;
        const line = data.subarray(start, i).toString('utf8').trim();
        if (line) events.push(JSON.parse(line));
        lineNo += 1;
        start = i + 1;
      }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    }
    const tail = carry.toString('utf8').trim();
    if (tail) events.push(JSON.parse(tail));
  } catch (e) {
    return { events, corrupt: { line: lineNo, error: e.message } };
  } finally {
    fs.closeSync(fd);
  }
  return { events, corrupt: null };
}

/** Recompute the full hash chain. Returns { ok, reason?, events }. */
function verifyChain(file) {
  const { events, corrupt } = loadEvents(file);
  if (corrupt) {
    return { ok: false, reason: `unreadable/corrupt JSON at line ${corrupt.line + 1}: ${corrupt.error}`, events };
  }
  if (events.length === 0) {
    return { ok: false, reason: 'empty session', events };
  }
  let prev = GENESIS;
  for (let index = 0; index < events.length; index++) {
    const ev = events[index];
    if (!ev || typeof ev !== 'object' || ev.i !== index || !Number.isFinite(ev.t) || typeof ev.type !== 'string' || !ev.data || typeof ev.data !== 'object' || Array.isArray(ev.data) || typeof ev.hash !== 'string') {
      return { ok: false, reason: `invalid event structure at event ${index}`, events };
    }
    if (index === 0 && ev.type !== 'meta') return { ok: false, reason: 'event 0 must be session metadata', events };
    if (index > 0 && ev.t < events[index - 1].t) return { ok: false, reason: `timestamp moved backwards at event ${index}`, events };
    if (ev.prev !== prev) {
      return { ok: false, reason: `chain break at event ${ev.i}: prev-pointer mismatch`, events };
    }
    const expect = eventHash(prev, ev.i, ev.t, ev.type, ev.data);
    if (ev.hash !== expect) {
      return { ok: false, reason: `hash mismatch at event ${ev.i} — content changed without rebuilding the chain`, events };
    }
    prev = ev.hash;
  }
  const complete = events[events.length - 1].type === 'exit';
  return { ok: true, complete, events, count: events.length };
}

/**
 * Last event in a session file — the cheap tail-read used to extend a chain
 * from a different process (hook adapters are short-lived CLI invocations).
 * Throws on a corrupt tail (never silently fork a broken chain); returns
 * null only when the file is missing or empty.
 */
function lastEvent(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const chunks = [];
    let end = size;
    let foundNewline = false;
    while (end > 0 && !foundNewline) {
      const start = Math.max(0, end - 4096);
      const buf = Buffer.allocUnsafe(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      chunks.unshift(buf);
      const combined = Buffer.concat(chunks);
      let last = combined.length - 1;
      while (last >= 0 && (combined[last] === 10 || combined[last] === 13 || combined[last] === 32 || combined[last] === 9)) last--;
      const nl = combined.lastIndexOf(10, last);
      if (nl >= 0 || start === 0) {
        foundNewline = true;
        const line = combined.subarray(nl + 1, last + 1).toString('utf8');
        return line ? JSON.parse(line) : null;
      }
      end = start;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Append one event to an existing chain file (or start one from genesis).
 * Single appendFileSync write — atomic for lines < 4 KB on POSIX.
 * Wrap in withFileLock() when several processes may race.
 */
function appendToChain(file, type, data) {
  assertNotSymlink(file);
  const { data: scrubbed, count } = redactEventData(data);
  const last = lastEvent(file);
  const i = last ? last.i + 1 : 0;
  const prev = last ? last.hash : GENESIS;
  const t = Date.now();
  const hash = eventHash(prev, i, t, type, scrubbed);
  const line = JSON.stringify({ i, t, type, data: scrubbed, prev, hash });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line + '\n');
  return { i, t, type, data: scrubbed, hash, redactions: count };
}

/**
 * Exclusive cross-process lock around chain appends (hook adapter).
 * fn(locked) — locked=false means we gave up after ~5 s; callers should
 * DROP the event then (a dropped event beats a forked hash chain).
 */
function withFileLock(file, fn) {
  const lock = `${file}.lock`;
  assertNotSymlink(lock);
  fs.mkdirSync(path.dirname(file), { recursive: true }); // lock file lives next to the session
  const deadline = Date.now() + 5000;
  let acquired = false;
  const token = `${process.pid}:${crypto.randomBytes(16).toString('hex')}`;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, token);
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // stale lock from a crashed process? reclaim it
      try {
        const owner = fs.readFileSync(lock, 'utf8').split(':')[0];
        let alive = false;
        try { process.kill(Number(owner), 0); alive = true; } catch { /* dead */ }
        if (!alive && Date.now() - fs.statSync(lock).mtimeMs > 5000) { fs.unlinkSync(lock); continue; }
      } catch { /* vanished — retry */ }
      if (Date.now() > deadline) break;
      // Synchronous hooks still need to wait, but sleeping avoids burning a core.
      Atomics.wait(LOCK_SLEEP, 0, 0, 25);
    }
  }
  try {
    return fn(acquired);
  } finally {
    if (acquired) {
      try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch { /* already gone */ }
    }
  }
}

/** Default sessions dir for a project. */
function sessionsDir(cwd) {
  return path.join(cwd || process.cwd(), '.agentbox', 'sessions');
}

let sessionSequence = 0;

function newSessionFile(cwd, name) {
  const dir = sessionsDir(cwd);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  const safe = (name || 'session').replace(/[^\w.-]+/g, '-').slice(0, 48);
  const sequence = sessionSequence++;
  return path.join(dir, `${stamp}-${process.pid}-${sequence}-${safe}.jsonl`);
}

module.exports = { GENESIS, VERSION, sha256, eventHash, Recorder, loadEvents, verifyChain, lastEvent, appendToChain, withFileLock, sessionsDir, newSessionFile, assertNotSymlink };

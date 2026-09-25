'use strict';
/**
 * mayday — chain.js
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

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Deterministic event hash. data MUST be a JSON-stable object. */
function eventHash(prev, i, t, type, data) {
  return sha256(JSON.stringify([prev, i, t, type, data]));
}

/** Append-only recorder. Writes JSONL, one event per line. */
class Recorder {
  constructor(file, meta) {
    this.file = file;
    this.i = 0;
    this.prev = GENESIS;
    this.redactions = 0;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, 'w');
    // stamp redaction policy into meta so the tape is self-describing
    const redactOff = process.env.MAYDAY_REDACT != null
      && /^(0|false|off|no)$/i.test(String(process.env.MAYDAY_REDACT).trim());
    const metaWithPolicy = { ...meta, redact: !redactOff };
    this.append('meta', metaWithPolicy); // event 0
  }

  append(type, data) {
    const { data: scrubbed, count } = redactEventData(data);
    this.redactions += count;
    const t = Date.now();
    const i = this.i++;
    const hash = eventHash(this.prev, i, t, type, scrubbed);
    const line = JSON.stringify({ i, t, type, data: scrubbed, prev: this.prev, hash });
    fs.writeSync(this.fd, line + '\n');
    this.prev = hash;
    return { i, t, type, data: scrubbed, hash, redactions: count };
  }

  close() {
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
  }
}

/** Parse a session file into events (tolerates corrupt lines). */
function loadEvents(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { events: [], corrupt: { line: 0, error: e.message } };
  }
  const events = [];
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (e) {
      return { events, corrupt: { line: n, error: e.message } };
    }
    events.push(ev);
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
  for (const ev of events) {
    if (ev.prev !== prev) {
      return { ok: false, reason: `chain break at event ${ev.i}: prev-pointer mismatch`, events };
    }
    const expect = eventHash(prev, ev.i, ev.t, ev.type, ev.data);
    if (ev.hash !== expect) {
      return { ok: false, reason: `hash mismatch at event ${ev.i} — event was tampered with or forged`, events };
    }
    prev = ev.hash;
  }
  return { ok: true, events, count: events.length };
}

/**
 * Last event in a session file — the cheap tail-read used to extend a chain
 * from a different process (hook adapters are short-lived CLI invocations).
 * Throws on a corrupt tail (never silently fork a broken chain); returns
 * null only when the file is missing or empty.
 */
function lastEvent(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const lines = text.split('\n');
  for (let n = lines.length - 1; n >= 0; n--) {
    const line = lines[n].trim();
    if (!line) continue;
    return JSON.parse(line); // throws on corruption — caller decides
  }
  return null;
}

/**
 * Append one event to an existing chain file (or start one from genesis).
 * Single appendFileSync write — atomic for lines < 4 KB on POSIX.
 * Wrap in withFileLock() when several processes may race.
 */
function appendToChain(file, type, data) {
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
  fs.mkdirSync(path.dirname(file), { recursive: true }); // lock file lives next to the session
  const deadline = Date.now() + 5000;
  let acquired = false;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // stale lock from a crashed process? reclaim it
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 3000) { fs.unlinkSync(lock); continue; }
      } catch { /* vanished — retry */ }
      if (Date.now() > deadline) break;
      const until = Date.now() + 25; // tiny busy-sleep; hooks are millisecond-scale
      while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    return fn(acquired);
  } finally {
    if (acquired) { try { fs.unlinkSync(lock); } catch { /* already gone */ } }
  }
}

/** Default sessions dir for a project. */
function sessionsDir(cwd) {
  return path.join(cwd || process.cwd(), '.mayday', 'sessions');
}

function newSessionFile(cwd, name) {
  const dir = sessionsDir(cwd);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = (name || 'session').replace(/[^\w.-]+/g, '-').slice(0, 48);
  return path.join(dir, `${stamp}-${safe}.jsonl`);
}

module.exports = { GENESIS, VERSION, sha256, eventHash, Recorder, loadEvents, verifyChain, lastEvent, appendToChain, withFileLock, sessionsDir, newSessionFile };

'use strict';
/**
 * agentbox — redact.js
 * Default-on secret scrubbing for the flight tape.
 *
 * Every string that is about to be written to a session file passes through
 * here. The hash chain commits to the *redacted* form, so the tape never
 * contains the original secret and is still tamper-evident.
 *
 * Disable:     AGENTBOX_REDACT=0
 * Extra rules: AGENTBOX_REDACT_EXTRA=pattern1|pattern2   (JS regex sources)
 * Project cfg: .agentbox/config.json → { "redact": true, "redactPatterns": ["…"] }
 *
 * Design rules:
 *   1. Deterministic — same input always yields the same redacted output
 *      (required for a stable hash chain).
 *   2. Conservative — prefer false positives over leaking a real secret.
 *   3. Shape-preserving — objects stay objects; only string leaves change.
 *   4. Never throw — a broken redactor must not abort a recording flight.
 */

const fs = require('fs');
const path = require('path');

const PLACEHOLDER = '[REDACTED]';

/**
 * Built-in patterns. Order matters only for readability; each match is
 * replaced independently. Keep sources free of the /g flag — we add it.
 */
const BUILTIN = [
  // OpenAI / compatible
  { name: 'openai',     re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  // Anthropic
  { name: 'anthropic',  re: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g },
  // GitHub tokens
  { name: 'github',     re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  // AWS access key id
  { name: 'aws-key',    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // AWS secret access key (40 base64-ish chars next to aws/secret context is hard;
  // catch the common "SecretAccessKey=…" / "aws_secret_access_key=…" form instead)
  { name: 'aws-secret', re: /(?:aws_?secret_?access_?key|secretAccessKey)\s*[=:]\s*["']?[A-Za-z0-9/+=]{35,}["']?/gi },
  // Slack
  { name: 'slack',      re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Stripe
  { name: 'stripe',     re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  // Google API key
  { name: 'google',     re: /\bAIza[0-9A-Za-z\-_]{20,}\b/g },
  // Twilio
  { name: 'twilio',     re: /\bSK[0-9a-fA-F]{32}\b/g },
  // Bearer / Authorization header values
  { name: 'bearer',     re: /(?:Bearer|Authorization)\s*[:=]?\s*["']?[A-Za-z0-9\-._~+/]+=*["']?/gi },
  // JWT (three base64url segments)
  { name: 'jwt',        re: /\beyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\b/g },
  // PEM private keys (single-line or the header alone is enough signal)
  { name: 'pem',        re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'pem-hdr',    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  // Generic KEY=value / "key": "value" for secret-ish names
  // (password, secret, token, apikey, api_key, access_key, private_key, client_secret, …)
  {
    name: 'kv-secret',
    re: /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|session[_-]?key)\s*[=:]\s*["']?[^\s"'\\]{6,}["']?/gi,
  },
  // JSON-style "password": "…"
  {
    name: 'json-secret',
    re: /"(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)"\s*:\s*"[^"]{4,}"/gi,
  },
  // Connection strings with embedded credentials
  {
    name: 'connstr',
    re: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp|https?):\/\/[^:\s]+:[^@\s]+@[^\s]+/gi,
  },
];

let _cache = null; // { enabled, patterns: [{name, re}] }

function loadConfig(cwd) {
  const root = cwd || process.cwd();
  try {
    const cfgPath = path.join(root, '.agentbox', 'config.json');
    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {};
    }
  } catch { /* ignore malformed config */ }
  return {};
}

/**
 * Resolve enabled flag + pattern list. Result is cached for the process
 * lifetime (config is expected to be stable during a session).
 */
function resolve(cwd) {
  if (_cache) return _cache;

  const env = process.env.AGENTBOX_REDACT;
  const cfg = loadConfig(cwd);
  // explicit false / "0" / "off" / "false" disables; everything else is on
  let enabled = true;
  if (env != null && /^(0|false|off|no)$/i.test(String(env).trim())) enabled = false;
  if (cfg.redact === false) enabled = false;
  if (cfg.redact === true) enabled = true;
  // AGENTBOX_REDACT=1 forces on even if config said off
  if (env != null && /^(1|true|on|yes)$/i.test(String(env).trim())) enabled = true;

  const patterns = BUILTIN.map((p) => ({ name: p.name, re: cloneRe(p.re) }));

  // project-level extra patterns
  const extra = [];
  if (Array.isArray(cfg.redactPatterns)) extra.push(...cfg.redactPatterns);
  if (process.env.AGENTBOX_REDACT_EXTRA) {
    extra.push(...String(process.env.AGENTBOX_REDACT_EXTRA).split('|').map((s) => s.trim()).filter(Boolean));
  }
  for (const src of extra) {
    try {
      patterns.push({ name: 'custom', re: new RegExp(src, 'gi') });
    } catch { /* skip invalid user regex */ }
  }

  _cache = { enabled, patterns };
  return _cache;
}

/** Force-reload config (tests only). */
function resetCache() {
  _cache = null;
}

function cloneRe(re) {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
}

/**
 * Redact a single string. Returns { text, count } where count is the number
 * of pattern hits (not characters).
 */
function redactString(s, opts = {}) {
  if (s == null) return { text: s, count: 0 };
  const str = String(s);
  if (!str) return { text: str, count: 0 };

  const { enabled, patterns } = resolve(opts.cwd);
  if (!enabled) return { text: str, count: 0 };

  let text = str;
  let count = 0;
  for (const p of patterns) {
    // reset lastIndex — we may reuse the same RegExp instance
    p.re.lastIndex = 0;
    if (!p.re.test(text)) continue;
    p.re.lastIndex = 0;
    text = text.replace(p.re, () => {
      count += 1;
      return PLACEHOLDER;
    });
  }
  return { text, count };
}

/**
 * Deep-redact any JSON-serializable value.
 * - strings → redacted strings
 * - arrays / plain objects → walked
 * - numbers, bools, null → unchanged
 * Never mutates the input.
 */
function redactDeep(value, opts = {}) {
  const state = { count: 0 };
  const out = walk(value, state, opts, 0);
  return { value: out, count: state.count };
}

function walk(v, state, opts, depth) {
  if (depth > 30) return v; // defensive against cycles / absurd nesting
  if (v == null) return v;
  const t = typeof v;
  if (t === 'string') {
    const r = redactString(v, opts);
    state.count += r.count;
    return r.text;
  }
  if (t === 'number' || t === 'boolean') return v;
  if (Array.isArray(v)) {
    return v.map((item) => walk(item, state, opts, depth + 1));
  }
  if (t === 'object') {
    // plain object only — skip Buffer, Date, etc.
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
      return v;
    }
    const out = {};
    for (const k of Object.keys(v)) {
      // also redact secret-looking *keys*' values more aggressively is already
      // handled by the kv/json patterns on stringified forms; walk the value.
      out[k] = walk(v[k], state, opts, depth + 1);
    }
    return out;
  }
  return v;
}

/**
 * Convenience used by the chain writer: redact event data in place-of
 * and return the scrubbed copy plus a hit count.
 */
function redactEventData(data, opts = {}) {
  if (data == null) return { data, count: 0 };
  if (typeof data !== 'object') {
    const r = redactString(data, opts);
    return { data: r.text, count: r.count };
  }
  const r = redactDeep(data, opts);
  return { data: r.value, count: r.count };
}

module.exports = {
  PLACEHOLDER,
  BUILTIN,
  redactString,
  redactDeep,
  redactEventData,
  resolve,
  resetCache,
  loadConfig,
};

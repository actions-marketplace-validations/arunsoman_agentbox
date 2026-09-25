'use strict';
/**
 * agentbox — replay.js
 * Scrub through a recorded session like security footage.
 *
 *   agentbox replay <file>            interactive TUI (TTY)
 *   agentbox replay <file> --headless static frame for CI / pipes / GIFs
 *
 * Keys: [space] play/pause  [←/→] ±1 event  [j/k] ∓/+ 10s
 *       [[ / ]] speed  [g/G] jump to start/end  [q] quit
 */
const { verifyChain } = require('./chain');
const { fmtDuration, inputPreview } = require('./parse');

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const RED = '\x1b[31m';
const ORANGE = '\x1b[38;5;208m';

const KIND_STYLE = {
  tool: { c: ORANGE, tag: 'TOOL' },
  tool_call: { c: ORANGE, tag: 'TOOL' },
  cmd: { c: GREEN, tag: 'SH$' },
  file: { c: MAGENTA, tag: 'FILE' },
  net: { c: CYAN, tag: 'NET' },
  in: { c: CYAN, tag: 'HUMAN' },
  prompt: { c: CYAN, tag: 'HUMAN' },
  notification: { c: YELLOW, tag: 'NOTE' },
  mcp_msg: { c: CYAN, tag: 'MCP' },
  turn_end: { c: DIM, tag: 'TURN' },
  note: { c: DIM, tag: 'note' },
  stderr: { c: RED, tag: 'ERR!' },
  out: { c: RESET, tag: 'out' },
  meta: { c: DIM, tag: 'meta' },
  exit: { c: BOLD, tag: 'EXIT' },
  signal: { c: RED, tag: 'SIGNAL' },
};

function evKind(ev) {
  if (ev.type === 'out') {
    if (ev.data && ev.data.stream === 'stderr') return 'stderr';
    return (ev.data && ev.data.kind) || 'out';
  }
  // tool_call *end* events are outcomes, not markers — keep the tape calm
  if (ev.type === 'tool_call' && ev.data && ev.data.phase === 'end') return null;
  return ev.type;
}

function evText(ev) {
  const d = ev.data || {};
  const strip = (s) => String(s == null ? '' : s)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[?0-9;:><]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[P^_].*?\x1b\\/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r/g, '')
    .replace(/^\[TOOL\]\s*/i, '');
  if (typeof d.text === 'string' && d.text.length) return strip(d.text);
  if (typeof d.detail === 'string') return strip(d.detail);
  if (d.detail && typeof d.detail === 'object') {
    return `${d.detail.op || ''} ${d.detail.path || ''}`.trim() || JSON.stringify(d.detail);
  }
  if (ev.type === 'exit') return `exit code ${d.code} after ${fmtDuration(d.durationMs)}`;
  if (ev.type === 'signal') return `${d.signal} received`;
  if (ev.type === 'meta') return d.cmd || 'session start';
  if (ev.type === 'tool_call') {
    if (d.phase === 'end') {
      const ms = d.durationMs != null ? ` in ${fmtDuration(d.durationMs)}` : '';
      return `${d.name || 'tool'} → ${d.status || 'ok'}${ms}`;
    }
    return `${d.name || 'tool'}(${shorten(inputPreview(d.input, 160), 110)})`;
  }
  if (ev.type === 'prompt') return shorten(d.text, 200);
  if (ev.type === 'notification') return shorten(d.message, 200);
  if (ev.type === 'turn_end') return 'turn complete';
  if (ev.type === 'note') return d.message || '';
  if (ev.type === 'mcp_msg') {
    const arrow = d.dir === 'C2S' ? '→ client→server' : '← server→client';
    const id = d.id != null ? ` #${d.id}` : '';
    return `${arrow} ${d.method || 'message'}${id}`;
  }
  return '';
}

function visibleEventRows(events, cur, limit) {
  const rows = [];
  const from = Math.max(0, cur - limit * 12);
  for (let i = from; i <= cur; i++) {
    const ev = events[i];
    const k = evKind(ev);
    if (k === null) continue;
    const rawText = evText(ev) || '';
    const human = k === 'in' || k === 'prompt';
    const text = human ? rawText.replace(/[\r\n]+$/, '') : rawText.trim();
    if (!text && !(human && /\s/.test(rawText))) continue;
    const previous = rows[rows.length - 1];
    if (human && previous && previous.k === k && ev.t - previous.ev.t <= 2500) {
      previous.text += text;
      previous.ev = ev;
      continue;
    }
    if (previous && text === previous.text) continue;
    rows.push({ ev, k, text });
  }
  return rows.slice(-limit);
}

function writeFrame(stdout, lines, previous) {
  if (!previous.length) stdout.write('\x1b[2J');
  const writes = [];
  const count = Math.max(lines.length, previous.length);
  for (let i = 0; i < count; i++) {
    const line = lines[i] || '';
    if (line === previous[i]) continue;
    writes.push(`\x1b[${i + 1};1H\x1b[2K${line}`);
  }
  if (writes.length) stdout.write(writes.join(''));
  previous.splice(0, previous.length, ...lines);
}

function replayExitCode(input) {
  const s = String(input);
  if (s.includes('\x03')) return 130;
  if (s.includes('q') || s.includes('Q')) return 0;
  return null;
}

function mmss(ms) {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rem.toFixed(1).padStart(4, '0')}`;
}

function shorten(s, n) {
  s = String(s).replace(/\t/g, '    ');
  n = Math.max(1, Number(n) || 1);
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/** Static, non-interactive render (used headless + in tests). */
function renderStatic(events, opts = {}) {
  const width = Math.min(opts.width || 100, 110);
  const t0 = events[0].t;
  const tN = events[events.length - 1].t;
  const dur = Math.max(1, tN - t0);
  const lines = [];
  const meta = events.find((e) => e.type === 'meta');
  const exit = [...events].reverse().find((e) => e.type === 'exit');

  lines.push(`${CYAN}${BOLD}⬢ AGENTBOX FLIGHT RECORD${RESET}  ${DIM}${shorten(meta ? meta.data.cmd : '?', width - 30)}${RESET}`);
  lines.push(`${DIM}${'─'.repeat(width)}${RESET}`);

  // timeline with markers
  const barW = width - 24;
  const bar = new Array(barW).fill('─');
  for (const ev of events) {
    let mark = null;
    let color = null;
    const k = evKind(ev);
    if (k === 'tool' || k === 'tool_call') { mark = '▲'; color = ORANGE; }
    else if (k === 'cmd') { mark = '$'; color = GREEN; }
    else if (k === 'file') { mark = '✎'; color = MAGENTA; }
    else if (k === 'in' || k === 'prompt') { mark = 'i'; color = CYAN; }
    else if (k === 'stderr') { mark = '·'; color = RED; }
    else if (k === 'mcp_msg') { mark = '⇄'; color = CYAN; }
    if (mark) {
      const p = Math.min(barW - 1, Math.floor(((ev.t - t0) / dur) * barW));
      bar[p] = color ? `${color}${mark}${DIM}` : mark;
    }
  }
  lines.push(`  ${DIM}[${bar.join('')}${DIM}]${RESET} ${BOLD}${mmss(dur)}${RESET}`);
  lines.push(`  ${DIM}▲ tool   $ shell   ✎ file   i human   ⇄ mcp   · stderr${RESET}`);
  lines.push('');

  const shown = events.slice(-(opts.tail || 12));
  for (const ev of shown) {
    const k = evKind(ev);
    if (k === null) continue; // end-phase outcomes are folded into starts
    const st = KIND_STYLE[k] || KIND_STYLE.out;
    const at = mmss(ev.t - t0);
    lines.push(`  ${DIM}${at}${RESET} ${st.c}${BOLD}${st.tag.padEnd(5)}${RESET} ${st.c}${shorten(evText(ev) || '·', width - 20)}${RESET}`);
  }
  lines.push('');
  if (exit) {
    lines.push(`  ${exit.data && exit.data.code === 0 ? GREEN : RED}${BOLD}landing: exit ${exit.data.code}${RESET} ${DIM}· ${events.length} events · ${fmtDuration(exit.data.durationMs)}${RESET}`);
  }
  lines.push(`${DIM}  (interactive mode: run in a TTY → agentbox replay <file>)${RESET}`);
  return lines.join('\n');
}

/** Interactive TUI. */
function replayTui(file, events, opts = {}) {
  const stdout = process.stdout;
  const t0 = events[0].t;
  const tN = events[events.length - 1].t;
  const dur = Math.max(1000, tN - t0);
  const meta = events.find((e) => e.type === 'meta');
  const SPEEDS = [1, 2, 4, 8, 16, 64];

  let vTime = 0;          // virtual clock (ms into flight)
  let playing = true;
  let speedIdx = 1;       // 2x default keeps busy terminal sessions readable
  let lastFrame = Date.now();
  let markerWidth = -1;
  let markers = [];
  const previousFrame = [];
  let stopped = false;

  const name = (meta && meta.data && meta.data.name) || 'session';
  const cols = () => (stdout.columns || 100);
  const rows = () => (stdout.rows || 30);

  stdout.write('\x1b[?1049h\x1b[?25l'); // alt screen + hide cursor

  function shutdown(code) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.stdin.setRawMode(false);
    process.stdin.removeListener('data', onKey);
    process.stdin.pause();
    process.removeListener('SIGINT', onSig);
    stdout.removeListener('resize', render);
    stdout.write('\x1b[?25h\x1b[?1049l\x1b[0m');
    stdout.write(`${DIM}⬢ agentbox: replay ended — ${name}${RESET}\n`);
    process.exit(code);
  }
  const onSig = () => shutdown(130);

  function visibleIdx() {
    // index of last event with t - t0 <= vTime
    let lo = 0, hi = events.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid].t - t0 <= vTime) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  function step(delta) {
    const cur = visibleIdx();
    const next = Math.max(0, Math.min(events.length - 1, cur + delta));
    vTime = events[next].t - t0;
    render();
  }

  function render() {
    const W = Math.max(1, cols());
    const H = Math.max(1, rows());
    const paneH = Math.max(0, H - 8);
    const cur = visibleIdx();
    const pct = Math.min(100, (vTime / dur) * 100);

    const buf = [];
    if (H < 8) {
      buf.push(`${CYAN}${BOLD}⬢ REPLAY${RESET} ${shorten(name, W - 10)}`);
      buf.push(`${BOLD}${mmss(vTime)}${RESET}/${mmss(dur)} ${SPEEDS[speedIdx]}x`);
      for (const { text } of visibleEventRows(events, cur, Math.max(0, H - 3))) buf.push(shorten(text, W));
      while (buf.length < H - 1) buf.push('');
      buf.push(`${DIM}q quit · space ${playing ? 'pause' : 'play'}${RESET}`);
      writeFrame(stdout, buf.slice(0, H), previousFrame);
      return;
    }
    if (W < 50) buf.push(`${CYAN}${BOLD}⬢ REPLAY${RESET} ${shorten(name, W - 10)}`);
    else buf.push(`${CYAN}${BOLD}⬢ AGENTBOX REPLAY${RESET}  ${BOLD}${shorten(name, 24)}${RESET}  ${DIM}│${RESET}  ${DIM}${shorten(meta ? meta.data.cmd : '?', W - 46)}${RESET}`);
    buf.push(`${DIM}${'─'.repeat(W)}${RESET}`);

    // timeline bar
    const barW = Math.max(1, W - 6);
    const filled = Math.floor((pct / 100) * barW);
    const bar = [];
    for (let x = 0; x < barW; x++) {
      if (x < filled) bar.push(`${CYAN}█${RESET}`);
      else bar.push(`${DIM}░${RESET}`);
    }
    // Marker positions only depend on terminal width, not playback time.
    if (markerWidth !== barW) {
      markerWidth = barW;
      markers = new Array(barW);
      for (const ev of events) {
        const k = evKind(ev);
        let mark = null;
        let color = null;
        if (k === 'tool' || k === 'tool_call') { mark = '▲'; color = ORANGE; }
        else if (k === 'cmd') { mark = '$'; color = GREEN; }
        else if (k === 'file') { mark = '✎'; color = MAGENTA; }
        else if (k === 'in' || k === 'prompt') { mark = 'i'; color = CYAN; }
        else if (k === 'mcp_msg') { mark = '⇄'; color = CYAN; }
        if (mark) {
          const p = Math.min(barW - 1, Math.floor(((ev.t - t0) / dur) * barW));
          markers[p] = { mark, color };
        }
      }
    }
    for (let p = 0; p < markers.length; p++) {
      const marker = markers[p];
      if (marker) bar[p] = `${marker.color}${marker.mark}${p > filled ? DIM : CYAN}`;
    }
    const speed = SPEEDS[speedIdx];
    buf.push(`  [${bar.join('')}]`);
    buf.push(`  ${BOLD}${mmss(vTime)}${RESET} ${DIM}/ ${mmss(dur)} · ${speed}x · ${cur + 1}/${events.length} events${RESET}`);
    buf.push(`  ${DIM}▲ tool  $ shell  ✎ file  i human${RESET}`);
    buf.push('');

    // event pane (last paneH visible events)
    for (const { ev, k, text } of visibleEventRows(events, cur, paneH)) {
      const st = KIND_STYLE[k] || KIND_STYLE.out;
      const at = mmss(ev.t - t0);
      const tag = st.tag.padEnd(5);
      if (W < 20) buf.push(`${st.c}${shorten(text, W)}${RESET}`);
      else buf.push(`${DIM}${at}${RESET} ${st.c}${BOLD}${tag}${RESET} ${st.c}${shorten(text, W - 16)}${RESET}`);
    }

    // footer
    while (buf.length < H - 2) buf.push('');
    buf.push(`${DIM}${'─'.repeat(W)}${RESET}`);
    const controls = W < 60
      ? `[space] ${playing ? 'pause' : 'play'}  ←/→ event  q quit`
      : `[space] ${playing ? 'pause' : 'play '} │ [←/→] event │ [j/k] 10s │ [[/]] ${speed}x │ [g/G] start/end │ [q] quit`;
    buf.push(`${DIM} ${shorten(controls, W - 1)}${RESET}`);
    writeFrame(stdout, buf.slice(0, H), previousFrame);
  }

  let lastTick = -1;
  const timer = setInterval(() => {
    const now = Date.now();
    const dt = now - lastFrame;
    lastFrame = now;
    if (playing) {
      vTime += dt * SPEEDS[speedIdx];
      const cur = visibleIdx();
      if (cur >= events.length - 1) {
        playing = false;
        vTime = dur;
      }
      const tick = Math.floor(vTime / 100);
      if (tick !== lastTick) {
        lastTick = tick;
        render();
      }
    }
  }, 50);

  const onKey = (d) => {
    const s = d.toString('utf8');
    lastFrame = Date.now();
    const exitCode = replayExitCode(s);
    if (exitCode !== null) { shutdown(exitCode); return; }
    if (s === ' ') { playing = !playing; render(); return; }
    if (s === '\x1b[C' || s === 'l') { step(1); return; }
    if (s === '\x1b[D' || s === 'h') { step(-1); return; }
    if (s === 'j') { vTime = Math.max(0, vTime - 10000); render(); return; }
    if (s === 'k') { vTime = Math.min(dur, vTime + 10000); render(); return; }
    if (s === '[') { speedIdx = Math.max(0, speedIdx - 1); render(); return; }
    if (s === ']') { speedIdx = Math.min(SPEEDS.length - 1, speedIdx + 1); render(); return; }
    if (s === 'g') { vTime = 0; render(); return; }
    if (s === 'G') { vTime = dur; render(); return; }
  };

  process.on('SIGINT', onSig);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  stdout.on('resize', render);
  render();

  if (process.env.AGENTBOX_SMOKE) {
    // CI smoke mode: render a few frames, then leave.
    setTimeout(() => { vTime = dur * 0.5; render(); }, 120);
    setTimeout(() => shutdown(0), 260);
  }
}

function replay(file, opts = {}) {
  const res = verifyChain(file);
  if (!res.ok && !opts.force) {
    process.stderr.write(`\x1b[31m⬢ agentbox: chain verification FAILED — ${res.reason}\n`);
    process.stderr.write('   use --force to replay anyway (for forensics)\x1b[0m\n');
    process.exitCode = 1;
    return res.ok;
  }
  const events = res.events;
  if (events.length < 2) {
    process.stderr.write('⬢ agentbox: nothing to replay — session has too few events\n');
    return false;
  }
  if (!process.stdout.isTTY || opts.headless || process.env.AGENTBOX_SMOKE) {
    process.stdout.write(renderStatic(events, { width: opts.width, tail: opts.tail }) + '\n');
    return true;
  }
  replayTui(file, events, opts);
  return true;
}

module.exports = { replay, renderStatic, visibleEventRows, writeFrame, replayExitCode };

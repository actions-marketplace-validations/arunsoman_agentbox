'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Recorder, verifyChain, eventHash, GENESIS } = require('../src/chain');
const { classifyLine, summarize } = require('../src/parse');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mayday-test-'));
}

test('hash chain: records, links, and verifies', () => {
  const dir = tmpdir();
  const file = path.join(dir, 's.jsonl');
  const rec = new Recorder(file, { name: 't', cmd: 'echo hi' });
  rec.append('out', { stream: 'stdout', kind: 'plain', text: 'hello' });
  rec.append('exit', { code: 0, durationMs: 12 });
  rec.close();

  const res = verifyChain(file);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.count, 3);
  // genesis linkage
  assert.equal(res.events[0].prev, GENESIS);
  assert.equal(res.events[1].prev, res.events[0].hash);
});

test('hash chain: tampering is detected', () => {
  const dir = tmpdir();
  const file = path.join(dir, 's.jsonl');
  const rec = new Recorder(file, { name: 't', cmd: 'x' });
  rec.append('out', { stream: 'stdout', kind: 'plain', text: 'innocent' });
  rec.append('exit', { code: 0, durationMs: 1 });
  rec.close();

  // attacker edits a line in place
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const ev = JSON.parse(lines[1]);
  ev.data.text = 'forged';
  lines[1] = JSON.stringify(ev);
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const res = verifyChain(file);
  assert.equal(res.ok, false);
  assert.match(res.reason, /event 1/);
});

test('classifyLine: tool, cmd, file, net, plain', () => {
  assert.equal(classifyLine('[TOOL] bash("ls")').kind, 'tool');
  assert.equal(classifyLine('$ npm test -- --ci').kind, 'cmd');
  assert.equal(classifyLine('git push origin main').kind, 'cmd');
  assert.deepEqual(classifyLine('edited config.yaml').detail, { op: 'edited', path: 'config.yaml' });
  assert.equal(classifyLine('see https://example.com/docs').kind, 'net');
  assert.equal(classifyLine('plain output line').kind, 'plain');
});

test('summarize: rolls up a session', () => {
  const dir = tmpdir();
  const file = path.join(dir, 's.jsonl');
  const rec = new Recorder(file, { name: 's', cmd: 'agent' });
  rec.append('out', { stream: 'stdout', kind: 'tool', text: '[TOOL] bash("ls")', detail: 'bash("ls")' });
  rec.append('out', { stream: 'stdout', kind: 'file', text: 'wrote a.txt', detail: { op: 'wrote', path: 'a.txt' } });
  rec.append('out', { stream: 'stderr', kind: 'plain', text: 'warn' });
  rec.append('in', { text: 'y' });
  rec.append('exit', { code: 0, durationMs: 1500 });
  rec.close();

  const res = verifyChain(file);
  const stats = summarize(res.events);
  assert.equal(stats.tools.length, 1);
  assert.equal(stats.files.length, 1);
  assert.equal(stats.stderrLines, 1);
  assert.equal(stats.humansConsulted, 1);
  assert.equal(stats.exitCode, 0);
  assert.equal(stats.durationMs, 1500);
});

test('wrap: end-to-end records a real child process', async () => {
  const { wrap } = require('../src/wrap');
  const dir = tmpdir();
  const file = path.join(dir, 'e2e.jsonl');
  const r = await wrap(['node', '-e', "console.log('hello from agent'); console.error('a warning')"], {
    file, quiet: true, cwd: dir,
  });
  assert.equal(r.exitCode, 0);
  const res = verifyChain(file);
  assert.equal(res.ok, true, res.reason);
  const texts = res.events.filter((e) => e.type === 'out').map((e) => e.data.text).join('\n');
  assert.match(texts, /hello from agent/);
  assert.match(texts, /a warning/);
  const exit = res.events.find((e) => e.type === 'exit');
  assert.equal(exit.data.code, 0);
});

test('receipt: text + markdown render from a real session', async () => {
  const { wrap } = require('../src/wrap');
  const { receipt } = require('../src/receipt');
  const dir = tmpdir();
  const file = path.join(dir, 'r.jsonl');
  await wrap(['node', '-e', "console.log('[TOOL] write(src/x.ts)'); console.log('created src/x.ts')"], { file, quiet: true, cwd: dir });
  const r = receipt(file, { format: 'text' });
  assert.equal(r.ok, true);
  const r2 = receipt(file, { format: 'markdown' });
  assert.equal(r2.ok, true);
});

test('clip: produces self-contained HTML', async () => {
  const { wrap } = require('../src/wrap');
  const { clip } = require('../src/clip');
  const dir = tmpdir();
  const file = path.join(dir, 'c.jsonl');
  await wrap(['node', '-e', "console.log('clip me')"], { file, quiet: true, cwd: dir });
  const out = clip(file);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /payload-json/);
  assert.match(html, /clip me/);
});

test('replay headless: renders a static frame', async () => {
  const { wrap } = require('../src/wrap');
  const dir = tmpdir();
  const file = path.join(dir, 'h.jsonl');
  await wrap(['node', '-e', "console.log('[TOOL] bash(\"deploy\")')"], { file, quiet: true, cwd: dir });
  const { renderStatic } = require('../src/replay');
  const res = verifyChain(file);
  const frame = renderStatic(res.events, { width: 90 });
  assert.match(frame, /MAYDAY FLIGHT RECORD/);
  assert.match(frame, /deploy/);
});

test('eventHash: deterministic', () => {
  const a = eventHash(GENESIS, 0, 1, 'meta', { x: 1 });
  const b = eventHash(GENESIS, 0, 1, 'meta', { x: 1 });
  const c = eventHash(GENESIS, 0, 1, 'meta', { x: 2 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('classifyLine: ANSI-colored tool lines are classified correctly', () => {
  const colored = '\x1b[38;5;208m[TOOL]\x1b[0m bash("git status --short")';
  const res = classifyLine(colored);
  assert.equal(res.kind, 'tool');
  assert.equal(res.detail, 'bash("git status --short")');
});

test('summarize: extracts file ops + tools + urls from a colored agent session', async () => {
  const { wrap } = require('../src/wrap');
  const dir = tmpdir();
  const file = path.join(dir, 'agent.jsonl');
  await wrap(['node', '-e', `
    const O='\\x1b[38;5;208m', R='\\x1b[0m';
    console.log(O+'[TOOL]'+R+' write(src/deploy.sh — 42 lines)');
    console.log(O+'[TOOL]'+R+' edit(config.yaml — max_users: 100 -> unlimited)');
    console.log(O+'[TOOL]'+R+' https://api.statuspage.io/v3/incidents — POST');
  `], { file, quiet: true, cwd: dir });
  const res = verifyChain(file);
  const stats = summarize(res.events);
  assert.equal(stats.tools.length, 3);
  assert.equal(stats.tools[0], 'write(src/deploy.sh — 42 lines)');
  assert.equal(stats.files.length, 2);
  assert.deepEqual(stats.files.map((f) => f.path).sort(), ['config.yaml', 'src/deploy.sh']);
  assert.equal(stats.urls.length, 1);
  assert.match(stats.urls[0], /statuspage\.io/);
});

// ---------------------------------------------------------------- adapters

const BIN = path.join(__dirname, '..', 'bin', 'mayday.js');

function spawnCLI(args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...process.env, MAYDAY_HOOKS_RECEIPT: process.env.MAYDAY_HOOKS_RECEIPT || '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

test('hook adapter: passive session from simulated Claude Code hooks', async () => {
  const dir = tmpdir();
  const sid = 'sess-3f9a2b7c-1111-2222-3333-444444444444';
  const send = (payload) => spawnCLI(['hook', 'claude'], dir, JSON.stringify(payload));

  // a full agent turn, one hook invocation per event (exactly how claude runs them)
  const r1 = await send({ session_id: sid, cwd: dir, hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(r1.code, 0, `SessionStart hook must exit 0: ${r1.err}`);
  const r2 = await send({ session_id: sid, cwd: dir, hook_event_name: 'UserPromptSubmit', prompt: 'fix the flaky retry test' });
  assert.equal(r2.code, 0);
  const r3 = await send({ session_id: sid, cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test -- --grep retry' }, tool_use_id: 'tu_1' });
  assert.equal(r3.code, 0);
  const r4 = await send({ session_id: sid, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: '12 passing' }, tool_use_id: 'tu_1' });
  assert.equal(r4.code, 0);
  const r5 = await send({ session_id: sid, cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'src/retry.ts', content: 'x' }, tool_use_id: 'tu_2' });
  assert.equal(r5.code, 0);
  const r6 = await send({ session_id: sid, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_response: { is_error: true, error: 'disk full' }, tool_use_id: 'tu_2' });
  assert.equal(r6.code, 0);
  const r7 = await send({ session_id: sid, cwd: dir, hook_event_name: 'Stop' });
  assert.equal(r7.code, 0);
  const r8 = await send({ session_id: sid, cwd: dir, hook_event_name: 'SessionEnd', reason: 'exit' });
  assert.equal(r8.code, 0);
  assert.equal(r8.out, '', 'hook must not print to stdout (control channel)');

  // find the session file
  const sessDir = path.join(dir, '.mayday', 'sessions');
  const files = fs.readdirSync(sessDir).filter((f) => f.endsWith(`-claude-${sid}.jsonl`));
  assert.equal(files.length, 1, 'one deterministic file per claude session_id');
  const file = path.join(sessDir, files[0]);

  // chain is intact and events landed
  const res = verifyChain(file);
  assert.equal(res.ok, true, res.reason);
  const types = res.events.map((e) => e.type);
  assert.ok(types.includes('meta'));
  assert.ok(types.includes('prompt'));
  assert.equal(types.filter((t) => t === 'tool_call').length, 4, '2 PreToolUse + 2 PostToolUse');
  assert.ok(types.includes('turn_end'));
  const exitEv = res.events.find((e) => e.type === 'exit');
  assert.ok(exitEv, 'SessionEnd writes the exit event');
  assert.equal(exitEv.data.source, 'claude-code');

  // summarize rolls it up like any other flight
  const stats = summarize(res.events);
  assert.equal(stats.adapter, 'claude-code');
  assert.equal(stats.toolCallStarts, 2);
  assert.equal(stats.toolErrors, 1);
  assert.equal(stats.turns, 1);
  assert.equal(stats.humansConsulted, 1);
  assert.match(stats.tools.join('\n'), /Bash\(npm test -- --grep retry\)/);
  assert.deepEqual(stats.files.map((f) => f.path), ['src/retry.ts']);

  // auto receipt was written on SessionEnd
  const receipts = fs.readdirSync(path.join(dir, '.mayday', 'receipts'));
  assert.equal(receipts.length, 1);
  const md = fs.readFileSync(path.join(dir, '.mayday', 'receipts', receipts[0]), 'utf8');
  assert.match(md, /MAYDAY flight receipt/);
  assert.match(md, /Bash\(npm test/);
});

test('hook adapter: survives garbage stdin and unknown events', async () => {
  const dir = tmpdir();
  const r1 = await spawnCLI(['hook', 'claude'], dir, 'this is not json {{{');
  assert.equal(r1.code, 0, 'garbage payload must still exit 0');
  const r2 = await spawnCLI(['hook', 'claude'], dir, '');
  assert.equal(r2.code, 0, 'empty payload must still exit 0');
  const r3 = await spawnCLI(['hook', 'claude'], dir, JSON.stringify({ session_id: 'x', cwd: dir, hook_event_name: 'FutureEvent', data: 1 }));
  assert.equal(r3.code, 0, 'unknown hook events must still exit 0');
  // unknown events still land as notes on deterministic tapes:
  // garbage + empty payloads (no session_id) fold into one '-claude-unknown' file,
  // the payload WITH a session_id gets its own file
  const sessDir = path.join(dir, '.mayday', 'sessions');
  const files = fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 2, 'one file per session_id (+1 for the id-less unknown session)');
  for (const f of files) {
    const res = verifyChain(path.join(sessDir, f));
    assert.equal(res.ok, true, `chain intact for ${f}: ${res.reason}`);
  }
  const unknownFile = files.find((f) => f.endsWith('-claude-unknown.jsonl'));
  assert.ok(unknownFile, 'id-less payloads share the deterministic unknown session');
  const notes = verifyChain(path.join(sessDir, unknownFile)).events.filter((e) => e.type === 'note');
  assert.ok(notes.length >= 2);
});

test('mcp proxy: records tools/call through the wire (end-to-end, real CLI subprocess)', async () => {
  const dir = tmpdir();
  const child = require('child_process').spawn(process.execPath, [
    BIN, 'mcp', '--', process.execPath, path.join(__dirname, '..', 'examples', 'fake-mcp-server.js'),
  ], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });

  // act as the MCP client: speak newline-delimited JSON-RPC over the pipes
  const responses = [];
  let split = null;
  const collected = new Promise((resolveCollected, rejectCollected) => {
    split = new (require('../src/adapters/mcp').LineSplitter)((line) => {
      try { responses.push(JSON.parse(line)); } catch { /* non-JSON — ignore */ }
      if ([1, 2, 3].every((id) => responses.some((r) => r.id === id))) resolveCollected();
    });
    setTimeout(() => rejectCollected(new Error(`timeout waiting for responses, got: ${JSON.stringify(responses)}`)), 10000);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => split.push(c));

  const sendMsg = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  sendMsg({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '0' } } });
  sendMsg({ jsonrpc: '2.0', method: 'notifications/initialized' });
  sendMsg({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  sendMsg({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello tape' } } });

  await collected;
  child.stdin.end(); // client hangs up
  const code = await new Promise((resolve) => child.on('close', (c) => resolve(c)));
  assert.equal(code, 0);

  // passthrough worked — the client really got the server's answers
  assert.ok(responses.some((r) => r.id === 1 && r.result && r.result.serverInfo && r.result.serverInfo.name === 'fake-everything'));
  assert.ok(responses.some((r) => r.id === 2 && r.result && r.result.tools && r.result.tools.length === 2));
  const callResp = responses.find((r) => r.id === 3);
  assert.match(callResp.result.content[0].text, /echo: hello tape/);

  // find the session tape
  const sessDir = path.join(dir, '.mayday', 'sessions');
  const files = fs.readdirSync(sessDir).filter((f) => f.endsWith('node-mcp.jsonl'));
  assert.equal(files.length, 1);
  const file = path.join(sessDir, files[0]);

  // the tape captured the whole conversation, hash-chained
  const res = verifyChain(file);
  assert.equal(res.ok, true, res.reason);
  const evs = res.events;
  assert.equal(evs.find((e) => e.type === 'meta').data.adapter, 'mcp');
  const msgs = evs.filter((e) => e.type === 'mcp_msg');
  assert.ok(msgs.length >= 6, 'every wire message is on the tape');
  const dirs = [...new Set(msgs.map((m) => m.data.dir))].sort();
  assert.deepEqual(dirs, ['C2S', 'S2C']);
  const callStart = evs.find((e) => e.type === 'tool_call' && e.data.phase === 'start');
  assert.equal(callStart.data.name, 'echo');
  assert.deepEqual(callStart.data.input, { text: 'hello tape' });
  const callEnd = evs.find((e) => e.type === 'tool_call' && e.data.phase === 'end');
  assert.equal(callEnd.data.status, 'ok');
  assert.ok(callEnd.data.durationMs >= 10, 'duration captured');
  const note = evs.find((e) => e.type === 'note' && /fake-everything/.test(String(e.data && e.data.message)));
  assert.ok(note, 'initialize response is distilled into a server note');
  assert.match(note.data.message, /v1\.2\.3/);

  // receipt understands MCP sessions
  const stats = summarize(evs);
  assert.equal(stats.adapter, 'mcp');
  assert.equal(stats.toolCallStarts, 1);
  assert.ok(stats.mcpMessages >= 6);
  assert.ok(stats.tools[0].startsWith('echo('), `tool label reads like a call: ${stats.tools[0]}`);
});

test('init claude: merges hooks idempotently, --remove strips them', () => {
  const dir = tmpdir();
  const cwdOrig = process.cwd();
  process.chdir(dir);
  try {
    const { initClaude } = require('../src/adapters/claude');
    const r1 = initClaude({});
    assert.equal(r1.changed, 7);
    const settings1 = JSON.parse(fs.readFileSync(r1.file, 'utf8'));
    assert.equal(Object.keys(settings1.hooks).length, 7);
    const pre = settings1.hooks.PreToolUse;
    assert.equal(pre.length, 1);
    assert.match(pre[0].hooks[0].command, /hook claude$/);
    assert.match(pre[0].hooks[0].command, /mayday\.js"/);

    // idempotent: re-init changes nothing
    const r2 = initClaude({});
    assert.equal(r2.changed, 0);
    const settings2 = JSON.parse(fs.readFileSync(r1.file, 'utf8'));
    assert.equal(settings2.hooks.PreToolUse.length, 1, 'no duplicate hook entries');

    // coexists with pre-existing hooks
    const settings3 = JSON.parse(fs.readFileSync(r1.file, 'utf8'));
    settings3.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] });
    fs.writeFileSync(r1.file, JSON.stringify(settings3, null, 2));
    const r4 = initClaude({});
    assert.equal(r4.changed, 0);
    const settings4 = JSON.parse(fs.readFileSync(r1.file, 'utf8'));
    assert.equal(settings4.hooks.PreToolUse.length, 2, 'foreign hook untouched');
    assert.equal(settings4.hooks.PreToolUse.filter((g) => g.hooks[0].command === 'echo mine').length, 1);

    // --remove strips only mayday's entries
    const r5 = initClaude({ remove: true });
    assert.equal(r5.changed, 7);
    const settings5 = JSON.parse(fs.readFileSync(r1.file, 'utf8'));
    assert.ok(!settings5.hooks || !settings5.hooks.PreToolUse || settings5.hooks.PreToolUse.every((g) => g.hooks[0].command === 'echo mine'));

    // re-init after remove works again
    const r6 = initClaude({});
    assert.equal(r6.changed, 7);
  } finally {
    process.chdir(cwdOrig);
  }
});

// ─── redaction ───────────────────────────────────────────────────────────────
// Fake secrets are built at runtime (joined fragments) so static secret
// scanners never see a continuous token literal in the source tree.

const {
  redactString, redactDeep, PLACEHOLDER, resetCache,
} = require('../src/redact');

/** Build a throwaway token that matches our patterns but is never a real credential. */
function fake(parts) {
  return parts.join('');
}

test('redact: strips common API tokens from strings', () => {
  resetCache();
  // each value is assembled so the full token never appears as one source literal
  const openai = fake(['sk-', 'abcdefghijklmnopqrstuvwxyz', '012345']);
  const openaiProj = fake(['sk-proj-', 'abcdefghijklmnopqrstuvwxyz', '0123456789']);
  const anthropic = fake(['sk-ant-api03-', 'abcdefghijklmnopqrstuvwxyz']);
  const github = fake(['ghp_', 'abcdefghijklmnopqrstuvwxyz', '0123456789']);
  const aws = fake(['AKIA', 'IOSFODNN7EXAMPLE']);
  const slack = fake(['xoxb-', '1234567890-', 'abcdefghijklmnop']);
  const stripe = fake(['sk_live_', 'abcdefghijklmnopqrstuv']);
  const google = fake(['AIza', 'SyA-abcdefghijklmnopqrstuvwxyz']);
  const jwt = fake([
    'eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    '.', 'eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0',
    '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ]);
  const pw = fake(['password=', 'not-a-real-credential-value']);
  const jsonKey = fake(['"api_key": "', 'abc123def456ghi789', '"']);
  const conn = fake(['postgres://admin:', 'not-real-pass', '@db.example.com:5432/app']);

  const samples = [
    [`Authorization: Bearer ${openai}`, true, openai],
    [`OPENAI_API_KEY=${openaiProj}`, true, openaiProj],
    [`anthropic key ${anthropic}`, true, anthropic],
    [github, true, github],
    [aws, true, aws],
    [slack, true, slack],
    [stripe, true, stripe],
    [google, true, google],
    [jwt, true, jwt.slice(0, 20)],
    [pw, true, 'not-a-real-credential-value'],
    [jsonKey, true, 'abc123def456ghi789'],
    [conn, true, 'not-real-pass'],
    ['hello world, nothing sensitive here', false, null],
    ['git status --short', false, null],
  ];
  for (const [input, expectHit, fragment] of samples) {
    const { text, count } = redactString(input);
    if (expectHit) {
      assert.ok(count > 0, `expected hit for: ${input}`);
      assert.ok(text.includes(PLACEHOLDER), `expected placeholder in: ${text}`);
      if (fragment) assert.ok(!text.includes(fragment), `leak of "${fragment}" in: ${text}`);
    } else {
      assert.equal(count, 0, `false positive on: ${input}`);
      assert.equal(text, input);
    }
  }
});

test('redact: deep-walks objects and arrays without mutating input', () => {
  resetCache();
  const tok = fake(['sk-', 'abcdefghijklmnopqrstuvwxyz', '012345']);
  const input = {
    tool: 'Bash',
    args: { command: `export TOKEN=${tok} && curl api` },
    nested: [{ secret: fake(['password=', 'not-a-real-credential-value']) }, 'plain'],
  };
  const clone = JSON.parse(JSON.stringify(input));
  const { value, count } = redactDeep(input);
  assert.ok(count >= 2);
  assert.deepEqual(input, clone, 'input must not be mutated');
  assert.ok(String(value.args.command).includes(PLACEHOLDER));
  assert.ok(String(value.nested[0].secret).includes(PLACEHOLDER));
  assert.equal(value.nested[1], 'plain');
});

test('redact: disabled via MAYDAY_REDACT=0', () => {
  resetCache();
  const prev = process.env.MAYDAY_REDACT;
  process.env.MAYDAY_REDACT = '0';
  resetCache();
  try {
    const secret = fake(['sk-', 'abcdefghijklmnopqrstuvwxyz', '012345']);
    const { text, count } = redactString(secret);
    assert.equal(count, 0);
    assert.equal(text, secret);
  } finally {
    if (prev === undefined) delete process.env.MAYDAY_REDACT;
    else process.env.MAYDAY_REDACT = prev;
    resetCache();
  }
});

test('redact: Recorder never writes secrets to the session file', () => {
  resetCache();
  const dir = tmpdir();
  const file = path.join(dir, 's.jsonl');
  const secret = fake(['sk-', 'abcdefghijklmnopqrstuvwxyz', '012345']);
  const rec = new Recorder(file, { name: 'redact-test', cmd: 'echo' });
  rec.append('out', { stream: 'stdout', kind: 'plain', text: `API_KEY=${secret}` });
  rec.append('tool_call', {
    phase: 'start',
    name: 'Bash',
    input: { command: `curl -H "Authorization: Bearer ${secret}" https://api.example.com` },
  });
  rec.append('exit', { code: 0, durationMs: 1 });
  rec.close();

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(secret), 'raw session file must not contain the secret');
  assert.ok(raw.includes(PLACEHOLDER), 'placeholder must appear');

  const res = verifyChain(file);
  assert.equal(res.ok, true, res.reason);
  // meta records redact policy
  assert.equal(res.events[0].data.redact, true);
  assert.ok(rec.redactions >= 2, `expected redaction hits, got ${rec.redactions}`);
});

test('redact: PEM private key block is fully scrubbed', () => {
  resetCache();
  // header/footer are the signal; body is obviously fake
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'NOTAREALKEY-just-test-material-for-redactor',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const { text, count } = redactString(`key material:\n${pem}\ndone`);
  assert.ok(count >= 1);
  assert.ok(!text.includes('NOTAREALKEY'));
  assert.ok(text.includes(PLACEHOLDER));
});

test('redact: event data path through appendToChain', () => {
  resetCache();
  const dir = tmpdir();
  const file = path.join(dir, 'hook.jsonl');
  const { appendToChain } = require('../src/chain');
  const secret = fake(['ghp_', 'abcdefghijklmnopqrstuvwxyz', '012345']);
  appendToChain(file, 'meta', { name: 't', cmd: 'claude' });
  const r = appendToChain(file, 'prompt', { text: `use token ${secret} please` });
  assert.ok(r.redactions >= 1);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(secret));
  assert.equal(verifyChain(file).ok, true);
});

'use strict';
/**
 * A minimal fake MCP server (stdio transport, newline-delimited JSON-RPC 2.0).
 * Used by the test suite and for trying `mayday mcp` without a real server:
 *
 *   mayday mcp -- node examples/fake-mcp-server.js
 *
 * Tools:
 *   echo(text)  → echoes back
 *   crash(text) → responds isError:true (for testing error capture)
 */
process.stdin.setEncoding('utf8');
let buf = '';

process.stdin.on('data', (c) => {
  buf += c;
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(line);
  }
});
process.stdin.on('end', () => {
  // let in-flight (setTimeout-delayed) responses flush before exiting
  setTimeout(() => process.exit(0), 120);
});

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification — nothing to answer

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-everything', version: '1.2.3' },
      },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echoes the text back',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
          {
            name: 'crash',
            description: 'Always fails (for testing error capture)',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    setTimeout(() => { // small latency so durationMs is non-zero on the tape
      if (name === 'crash') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { isError: true, content: [{ type: 'text', text: `boom: ${args.text || 'kaboom'}` }] },
        });
      } else {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `echo: ${args.text != null ? args.text : JSON.stringify(args)}` }] },
        });
      }
    }, 15);
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
}

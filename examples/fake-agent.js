'use strict';
/**
 * examples/fake-agent.js
 * A scripted "agent" that behaves like the real thing — tools, edits,
 * a deploy, one questionable decision — so you can see agentbox work
 * without wiring up an actual LLM. Used by `agentbox demo`.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ORANGE = '\x1b[38;5;208m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

async function main() {
  process.stdout.write(`${DIM}autonomous-deploy-agent v2.3 starting… (confidence: 100%, supervision: 0%)${RESET}\n`);
  await sleep(400);

  process.stdout.write(`${ORANGE}[TOOL]${RESET} bash("git status --short")\n`);
  await sleep(300);
  process.stdout.write('  M src/deploy.sh\n  ?? notes/friday-plan.md\n');
  await sleep(250);

  process.stdout.write(`${ORANGE}[TOOL]${RESET} write(src/deploy.sh — 42 lines)\n`);
  await sleep(400);
  process.stdout.write(`${ORANGE}[TOOL]${RESET} bash("./deploy.sh --env=prod")\n`);
  await sleep(500);
  for (const step of ['building image… done', 'pushing to registry… done', 'draining old pods… done']) {
    process.stdout.write(`  ${DIM}▸${RESET} ${step}\n`);
    await sleep(300);
  }

  process.stdout.write(`${ORANGE}[TOOL]${RESET} bash("npm test -- --ci")\n`);
  await sleep(600);
  process.stdout.write('  148 tests passed, 0 failed, 3 skipped\n');
  await sleep(300);

  process.stdout.write(`${ORANGE}[TOOL]${RESET} edit(config.yaml — max_users: 100 -> unlimited)\n`);
  await sleep(400);

  process.stdout.write(`${ORANGE}[TOOL]${RESET} https://api.statuspage.io/v3/incidents — POST\n`);
  await sleep(300);
  process.stdout.write('  201 Created\n');
  await sleep(250);

  process.stdout.write('$ rm -rf /tmp/old-builds\n');
  await sleep(300);

  process.stdout.write(`${ORANGE}[TOOL]${RESET} email(send: board@bigcorp.com — "shipped to prod on friday, yolo")\n`);
  await sleep(500);

  process.stdout.write(`${GREEN}deployment complete. no humans were consulted. ✅${RESET}\n`);
  process.exit(0);
}

main();

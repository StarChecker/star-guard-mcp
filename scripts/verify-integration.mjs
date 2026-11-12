#!/usr/bin/env node
/**
 * E2E-проверка MCP → Star Guard → детерминированная трактовка.
 *
 * Требует запущенный Star Guard. Для мокового сценария:
 *   java -jar target/star-guard-core-*.jar \
 *     --app.archive.mode=fixture --app.scoring.mock-mode=suspicious
 *
 * Запуск:
 *   STAR_GUARD_API_URL=http://localhost:8080 node scripts/verify-integration.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import process from 'node:process';

const apiUrl = process.env.STAR_GUARD_API_URL ?? 'http://localhost:8080';
const owner = process.env.VERIFY_OWNER ?? 'demo';
const name = process.env.VERIFY_NAME ?? 'star-guard';
const hours = Number(process.env.VERIFY_HOURS ?? 3);

const child = spawn(process.execPath, ['src/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, STAR_GUARD_API_URL: apiUrl },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
let nextId = 1;
const pending = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const message = JSON.parse(line);
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

function request(method, params = {}) {
  const id = nextId++;
  const message = { jsonrpc: '2.0', id, method, params };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP timeout: ${method}`));
    }, 30000);
    pending.set(id, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

try {
  const init = await request('initialize', { protocolVersion: '2025-06-18' });
  console.log(`initialize: ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);

  const tools = await request('tools/list');
  console.log(`tools: ${tools.result.tools.map((tool) => tool.name).join(', ')}`);

  const call = await request('tools/call', {
    name: 'assess_dependency',
    arguments: { owner, name, hours },
  });
  if (call.result?.isError) {
    throw new Error(`Tool error: ${call.result.content?.[0]?.text}`);
  }
  const payload = JSON.parse(call.result.content[0].text);
  console.log(JSON.stringify(payload, null, 2));

  assert.equal(payload.repository, `${owner}/${name}`);
  assert.ok(payload.score !== null && payload.score !== undefined, 'score is missing');
  assert.ok(payload.interpretation?.category, 'interpretation category is missing');
  assert.ok(
    ['healthy', 'borderline', 'suspicious', 'critical', 'insufficient_data']
      .includes(payload.interpretation.category),
  );
  assert.ok(payload.interpretation.recommendation, 'recommendation is missing');
  console.log('\nOK: MCP → Star Guard → interpretation');
} finally {
  child.kill();
}

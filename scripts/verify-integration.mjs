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
const days = process.env.VERIFY_DAYS ? Number(process.env.VERIFY_DAYS) : undefined;

const EXPECTED_TOOLS = [
  'assess_dependency',
  'get_repo_report',
  'get_repo_history',
  'get_preview',
  'start_scan',
  'get_scan',
  'list_indexed_repos',
  'batch_summaries',
  'get_badge',
];

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
  const toolNames = tools.result.tools.map((tool) => tool.name);
  console.log(`tools: ${toolNames.join(', ')}`);
  for (const expected of EXPECTED_TOOLS) {
    assert.ok(toolNames.includes(expected), `tool ${expected} is not exposed`);
  }

  const call = await request('tools/call', {
    name: 'assess_dependency',
    arguments: { owner, name, hours, ...(days == null ? {} : { days }) },
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
  if (payload.evidence?.source) {
    assert.ok(
      ['gh_archive_index', 'gh_archive', 'github_api'].includes(payload.evidence.source),
      `unexpected evidence.source: ${payload.evidence.source}`,
    );
    console.log(`source: ${payload.evidence.source}`);
  }

  const batchCall = await request('tools/call', {
    name: 'batch_summaries',
    arguments: { repos: [`${owner}/${name}`], hours },
  });
  if (batchCall.result?.isError) {
    throw new Error(`batch_summaries error: ${batchCall.result.content?.[0]?.text}`);
  }
  const batch = JSON.parse(batchCall.result.content[0].text);
  assert.ok(Array.isArray(batch.data), 'batch_summaries must return a JSON array');
  assert.equal(batch.data.length, 1);
  console.log(`batch: status=${batch.data[0]?.status}`);

  if (process.env.VERIFY_INDEX === '1') {
    const indexCall = await request('tools/call', {
      name: 'list_indexed_repos',
      arguments: { limit: 5 },
    });
    const index = JSON.parse(indexCall.result.content[0].text);
    assert.ok([200, 503].includes(index.status), `unexpected index status ${index.status}`);
    console.log(`index: HTTP ${index.status}${index.data?.code ? ` (${index.data.code})` : ''}`);
  }

  if (process.env.VERIFY_GITHUB === '1') {
    for (const [tool, args] of [
      ['get_repo_history', { owner, name, days: days ?? 30 }],
      ['get_preview', { owner, name }],
    ]) {
      const githubCall = await request('tools/call', { name: tool, arguments: args });
      const result = JSON.parse(githubCall.result.content[0].text);
      assert.equal(result.status, 200, `${tool} failed: ${result.data?.code ?? result.status}`);
      console.log(`${tool}: HTTP 200`);
    }
  }

  console.log('\nOK: MCP → Star Guard → interpretation');
} finally {
  child.kill();
}

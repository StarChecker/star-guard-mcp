import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { McpServer, runStdio } from '../src/mcp-server.js';

function fakeClient() {
  return {
    baseUrl: 'http://core',
    async assess(owner, name) {
      return {
        repository: `${owner}/${name}`,
        score: 72,
        level: 'high',
        interpretation: {
          category: 'suspicious',
          recommendation: 'review_before_use',
          reasons: [],
          caveats: [],
          confidence: 'medium',
        },
      };
    },
    async getReport(owner, name) {
      return { status: 200, data: { repo: { full_name: `${owner}/${name}` } } };
    },
    async startScan() {
      return { status: 202, data: { id: 'scan-1' } };
    },
    async getScan() {
      return { status: 200, data: { id: 'scan-1', status: 'running' } };
    },
    async listIndexedRepos() {
      return { status: 200, data: { repos: [] } };
    },
    async batchSummaries() {
      return { status: 200, data: { summaries: [] } };
    },
    async getBadge() {
      return { status: 200, data: {} };
    },
  };
}

test('initialize exposes supported protocol and tool capability', async () => {
  const server = new McpServer({ client: fakeClient() });
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  });

  assert.equal(response.result.protocolVersion, '2025-06-18');
  assert.deepEqual(response.result.capabilities.tools, { listChanged: false });
  assert.equal(response.result.serverInfo.name, 'star-guard-mcp');
});

test('tools/list contains all tools', async () => {
  const server = new McpServer({ client: fakeClient() });
  const response = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = response.result.tools.map((tool) => tool.name);

  assert.ok(names.includes('assess_dependency'));
  assert.ok(names.includes('get_repo_report'));
  assert.ok(names.includes('start_scan'));
  assert.ok(names.includes('get_scan'));
  assert.ok(names.includes('list_indexed_repos'));
  assert.ok(names.includes('batch_summaries'));
  assert.ok(names.includes('get_badge'));
});

test('tools/call assess_dependency returns text JSON and isError=false', async () => {
  const server = new McpServer({ client: fakeClient() });
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'assess_dependency', arguments: { owner: 'demo', name: 'farm' } },
  });

  assert.equal(response.result.isError, false);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.repository, 'demo/farm');
  assert.equal(payload.interpretation.category, 'suspicious');
});

test('tool errors are returned as isError=true and do not crash the server', async () => {
  const server = new McpServer({ client: fakeClient() });
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'unknown_tool', arguments: {} },
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Unknown tool/);
});

test('unknown methods return JSON-RPC error, notifications do not respond', async () => {
  const server = new McpServer({ client: fakeClient() });
  const error = await server.handle({ jsonrpc: '2.0', id: 5, method: 'nope' });
  assert.equal(error.error.code, -32601);

  const notification = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification, null);
});

test('runStdio handles newline-delimited JSON-RPC and writes responses', async () => {
  const input = Readable.from([
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`,
  ]);
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const errorOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

  await runStdio({ client: fakeClient(), input, output, errorOutput });

  const responses = chunks.join('').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.equal(responses[0].result.serverInfo.name, 'star-guard-mcp');
  assert.deepEqual(responses[1].result, {});
});

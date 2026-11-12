import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { McpServer, runStdio } from '../src/mcp-server.js';

function fakeClient(calls = []) {
  return {
    baseUrl: 'http://core',
    calls,
    async assess(owner, name, options) {
      calls.push(['assess', owner, name, options]);
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
    async getReport(owner, name, hours, days) {
      calls.push(['getReport', owner, name, hours, days]);
      return { status: 200, data: { repo: { full_name: `${owner}/${name}` } } };
    },
    async getRepoHistory(owner, name, days) {
      calls.push(['getRepoHistory', owner, name, days]);
      return { status: 200, data: { source: { type: 'github_api' } } };
    },
    async getPreview(owner, name) {
      calls.push(['getPreview', owner, name]);
      return { status: 200, data: { stars: 100 } };
    },
    async startScan(owner, name, hours, source) {
      calls.push(['startScan', owner, name, hours, source]);
      return { status: 202, data: { id: 'scan-1' } };
    },
    async getScan() {
      return { status: 200, data: { id: 'scan-1', status: 'running' } };
    },
    async listIndexedRepos(options) {
      calls.push(['listIndexedRepos', options]);
      return { status: 200, data: { repos: [] } };
    },
    async batchSummaries(repos, hours) {
      calls.push(['batchSummaries', repos, hours]);
      return { status: 200, data: [] };
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
  assert.ok(names.includes('get_repo_history'));
  assert.ok(names.includes('get_preview'));
  assert.ok(names.includes('start_scan'));
  assert.ok(names.includes('get_scan'));
  assert.ok(names.includes('list_indexed_repos'));
  assert.ok(names.includes('batch_summaries'));
  assert.ok(names.includes('get_badge'));
  assert.equal(names.length, 9);
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

test('tool arguments are forwarded to the client', async () => {
  const calls = [];
  const server = new McpServer({ client: fakeClient(calls) });

  const call = (name, args) => server.handle({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  await call('assess_dependency', { owner: 'demo', name: 'repo', hours: 6, days: 30 });
  await call('get_repo_report', { owner: 'demo', name: 'repo', days: 7 });
  await call('get_repo_history', { owner: 'demo', name: 'repo', days: 14 });
  await call('get_preview', { owner: 'demo', name: 'repo' });
  await call('start_scan', { owner: 'demo', name: 'repo', hours: 6, source: 'archive' });
  await call('list_indexed_repos', {
    limit: 5, existing_only: false, with_score: true, max_level: 'low',
  });

  assert.deepEqual(calls[0], ['assess', 'demo', 'repo', {
    hours: 6, days: 30, waitForScan: true, scanTimeoutMs: undefined,
  }]);
  assert.deepEqual(calls[1], ['getReport', 'demo', 'repo', undefined, 7]);
  assert.deepEqual(calls[2], ['getRepoHistory', 'demo', 'repo', 14]);
  assert.deepEqual(calls[3], ['getPreview', 'demo', 'repo']);
  assert.deepEqual(calls[4], ['startScan', 'demo', 'repo', 6, 'archive']);
  assert.deepEqual(calls[5], ['listIndexedRepos', {
    limit: 5, existingOnly: false, withScore: true, maxLevel: 'low',
  }]);
});

test('get_repo_history and get_preview return text JSON', async () => {
  const server = new McpServer({ client: fakeClient() });

  const history = await server.handle({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'get_repo_history', arguments: { owner: 'demo', name: 'repo' } },
  });
  const preview = await server.handle({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'get_preview', arguments: { owner: 'demo', name: 'repo' } },
  });

  assert.equal(history.result.isError, false);
  assert.equal(JSON.parse(history.result.content[0].text).data.source.type, 'github_api');
  assert.equal(preview.result.isError, false);
  assert.equal(JSON.parse(preview.result.content[0].text).data.stars, 100);
});

test('invalid enum arguments are rejected before HTTP', async () => {
  const calls = [];
  const server = new McpServer({ client: fakeClient(calls) });

  const badSource = await server.handle({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: { name: 'start_scan', arguments: { owner: 'demo', name: 'repo', source: 'ftp' } },
  });
  const badLevel = await server.handle({
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: { name: 'list_indexed_repos', arguments: { max_level: 'none' } },
  });

  assert.equal(badSource.result.isError, true);
  assert.match(badSource.result.content[0].text, /source must be one of/);
  assert.equal(badLevel.result.isError, true);
  assert.match(badLevel.result.content[0].text, /max_level must be one of/);
  assert.equal(calls.length, 0);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { StarGuardClient, StarGuardError } from '../src/client.js';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function report(level = 'critical', score = 90) {
  return {
    repo: { full_name: 'demo/repo' },
    window: { hours: 6 },
    stats: { stars: 120 },
    score: {
      score,
      level,
      confidence: 0.9,
      mocked: false,
      insufficient_data: false,
      verdict: 'Сильные признаки накрутки.',
      checks: [],
    },
    archive: { missing_hours: [], parse_errors: 0 },
  };
}

test('assess returns deterministic interpretation for indexed repo', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    return jsonResponse(200, report('high', 72));
  };
  const client = new StarGuardClient({ baseUrl: 'http://core', fetchImpl });

  const result = await client.assess('demo', 'repo', { hours: 6 });

  assert.equal(result.interpretation.category, 'suspicious');
  assert.equal(result.interpretation.recommendation, 'review_before_use');
  assert.equal(result.repository, 'demo/repo');
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /hours=6/);
});

test('assess starts scan for repo outside index and polls until done', async () => {
  let polls = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/v1/repos/demo/outside')) {
      return jsonResponse(404, { code: 'REPO_NOT_INDEXED', detail: 'not indexed' });
    }
    if (url.endsWith('/api/v1/scans') && options.method === 'POST') {
      return jsonResponse(202, { id: 'scan-1', status: 'queued' });
    }
    if (url.endsWith('/api/v1/scans/scan-1')) {
      polls++;
      if (polls === 1) {
        return jsonResponse(200, { id: 'scan-1', status: 'running' });
      }
      return jsonResponse(200, { id: 'scan-1', status: 'done', report: report() });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const client = new StarGuardClient({
    baseUrl: 'http://core',
    fetchImpl,
    pollIntervalMs: 1,
  });

  const result = await client.assess('demo', 'outside', {});

  assert.equal(result.status, 'done');
  assert.equal(result.scan_id, 'scan-1');
  assert.equal(result.interpretation.category, 'critical');
  assert.equal(polls, 2);
});

test('assess returns no_data and index_not_ready statuses', async () => {
  const noData = new StarGuardClient({
    baseUrl: 'http://core',
    fetchImpl: async () => jsonResponse(404, { code: 'REPO_NOT_FOUND_IN_WINDOW' }),
  });
  assert.equal((await noData.assess('demo', 'empty', {})).status, 'no_data');

  const notReady = new StarGuardClient({
    baseUrl: 'http://core',
    fetchImpl: async () => jsonResponse(503, { code: 'INDEX_NOT_READY' }),
  });
  assert.equal((await notReady.assess('demo', 'repo', {})).status, 'index_not_ready');
});

test('network failure becomes StarGuardError API_UNREACHABLE', async () => {
  const client = new StarGuardClient({
    baseUrl: 'http://core',
    fetchImpl: async () => { throw new Error('connection refused'); },
  });
  await assert.rejects(
    () => client.getReport('demo', 'repo'),
    (error) => error instanceof StarGuardError && error.code === 'API_UNREACHABLE',
  );
});

test('batch and index calls use expected payloads', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('/api/v1/repos/batch')) {
      return jsonResponse(200, { summaries: [] });
    }
    return jsonResponse(200, { repos: [] });
  };
  const client = new StarGuardClient({ baseUrl: 'http://core', fetchImpl });

  await client.batchSummaries(['a/one', 'b/two'], 3);
  await client.listIndexedRepos(5);

  assert.equal(JSON.parse(requests[0].options.body).repos.length, 2);
  assert.match(requests[1].url, /limit=5/);
});

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
    archive: { hours_requested: 6, hours_loaded: 6, missing_hours: [], parse_errors: 0 },
    source: { type: 'gh_archive' },
  };
}

function scan(scanId, status, extra = {}) {
  return {
    id: scanId,
    repo: { owner: 'demo', name: 'outside', full_name: 'demo/outside' },
    status,
    source: 'archive',
    hours_done: 0,
    hours_total: 3,
    created_at: '2026-11-13T00:00:00Z',
    report: null,
    error_code: null,
    error_message: null,
    ...extra,
  };
}

test('assess returns deterministic interpretation for indexed repo', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    return jsonResponse(200, report('high', 72));
  };
  const client = new StarGuardClient({ baseUrl: 'http://core', fetchImpl });

  const result = await client.assess('demo', 'repo', { hours: 6, days: 30 });

  assert.equal(result.interpretation.category, 'suspicious');
  assert.equal(result.interpretation.recommendation, 'review_before_use');
  assert.equal(result.repository, 'demo/repo');
  assert.equal(result.evidence.source, 'gh_archive');
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /hours=6/);
  assert.match(calls[0][0], /days=30/);
});

test('assess omits days when it is not supplied', async () => {
  const calls = [];
  const client = new StarGuardClient({
    baseUrl: 'http://core',
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse(200, report());
    },
  });

  await client.assess('demo', 'repo', { hours: 6 });
  assert.doesNotMatch(calls[0], /days=/);
});

test('assess starts scan for repo outside index and polls until done', async () => {
  let polls = 0;
  let scanBody = null;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/v1/repos/demo/outside')) {
      return jsonResponse(404, { code: 'REPO_NOT_INDEXED', detail: 'not indexed' });
    }
    if (url.endsWith('/api/v1/scans') && options.method === 'POST') {
      scanBody = JSON.parse(options.body);
      return jsonResponse(202, scan('scan-1', 'queued'));
    }
    if (url.endsWith('/api/v1/scans/scan-1')) {
      polls++;
      if (polls === 1) {
        return jsonResponse(200, scan('scan-1', 'running', { hours_done: 1 }));
      }
      return jsonResponse(200, scan('scan-1', 'done', { report: report() }));
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
  assert.deepEqual(scanBody, { owner: 'demo', name: 'outside' });
});

test('assess falls back to archive scan for GitHub source errors', async () => {
  const codes = [
    'GITHUB_TOKEN_REQUIRED',
    'GITHUB_TOKEN_INVALID',
    'GITHUB_RATE_LIMITED',
    'GITHUB_UNAVAILABLE',
    'GITHUB_HISTORY_NOT_READY',
  ];
  for (const code of codes) {
    const scanBodies = [];
    const fetchImpl = async (url, options) => {
      if (url.includes('/api/v1/repos/demo/repo')) {
        return jsonResponse(503, { code, detail: 'github unavailable' });
      }
      if (url.endsWith('/api/v1/scans') && options.method === 'POST') {
        scanBodies.push(JSON.parse(options.body));
        return jsonResponse(202, scan('scan-9', 'queued'));
      }
      if (url.endsWith('/api/v1/scans/scan-9')) {
        return jsonResponse(200, scan('scan-9', 'done', { report: report('high', 60) }));
      }
      throw new Error(`unexpected request ${url}`);
    };
    const client = new StarGuardClient({ baseUrl: 'http://core', fetchImpl, pollIntervalMs: 1 });

    const result = await client.assess('demo', 'repo', { hours: 6 });

    assert.equal(result.status, 'done', code);
    assert.equal(result.interpretation.category, 'suspicious', code);
    assert.deepEqual(scanBodies, [{ owner: 'demo', name: 'repo', hours: 6, source: 'archive' }], code);
  }
});

test('GitHub fallback without waiting returns scanning with source', async () => {
  const fetchImpl = async (url, options) => {
    if (url.includes('/api/v1/repos/demo/repo')) {
      return jsonResponse(503, { code: 'GITHUB_TOKEN_REQUIRED' });
    }
    if (url.endsWith('/api/v1/scans') && options.method === 'POST') {
      return jsonResponse(202, scan('scan-2', 'queued'));
    }
    throw new Error(`unexpected request ${url}`);
  };
  const client = new StarGuardClient({ baseUrl: 'http://core', fetchImpl });

  const result = await client.assess('demo', 'repo', { waitForScan: false });

  assert.equal(result.status, 'scanning');
  assert.equal(result.scan_id, 'scan-2');
  assert.equal(result.source, 'archive');
});

test('assess maps repo_not_found, no_data, index_not_ready and archive errors', async () => {
  const cases = [
    [404, 'REPO_NOT_FOUND_IN_WINDOW', 'no_data'],
    [404, 'REPO_NOT_FOUND_ON_GITHUB', 'repo_not_found'],
    [503, 'INDEX_NOT_READY', 'index_not_ready'],
    [502, 'ARCHIVE_UNAVAILABLE', 'error'],
    [400, 'INVALID_REQUEST', 'error'],
  ];
  for (const [httpStatus, code, expected] of cases) {
    let posted = false;
    const client = new StarGuardClient({
      baseUrl: 'http://core',
      fetchImpl: async (url, options) => {
        if (options?.method === 'POST') {
          posted = true;
        }
        return jsonResponse(httpStatus, { code, detail: `detail for ${code}` });
      },
    });

    const result = await client.assess('demo', 'repo', {});

    assert.equal(result.status, expected, code);
    assert.equal(result.code, code);
    assert.equal(result.message, `detail for ${code}`);
    assert.equal(posted, false, `${code} must not start a scan`);
  }
});

test('failed scan returns scan failure fields', async () => {
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/v1/repos/demo/outside')) {
      return jsonResponse(404, { code: 'REPO_NOT_INDEXED' });
    }
    if (url.endsWith('/api/v1/scans') && options.method === 'POST') {
      return jsonResponse(202, scan('scan-3', 'queued'));
    }
    return jsonResponse(200, scan('scan-3', 'failed', {
      error_code: 'ARCHIVE_UNAVAILABLE',
      error_message: 'GH Archive недоступен',
    }));
  };
  const client = new StarGuardClient({ baseUrl: 'http://core', fetchImpl, pollIntervalMs: 1 });

  const result = await client.assess('demo', 'outside', {});

  assert.equal(result.status, 'failed');
  assert.equal(result.scan_id, 'scan-3');
  assert.equal(result.error_code, 'ARCHIVE_UNAVAILABLE');
  assert.equal(result.error_message, 'GH Archive недоступен');
});

test('scan done without report returns SCAN_REPORT_MISSING', async () => {
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/v1/repos/demo/outside')) {
      return jsonResponse(404, { code: 'REPO_NOT_INDEXED' });
    }
    if (url.endsWith('/api/v1/scans') && options.method === 'POST') {
      return jsonResponse(202, scan('scan-4', 'queued'));
    }
    return jsonResponse(200, scan('scan-4', 'done'));
  };
  const client = new StarGuardClient({
    baseUrl: 'http://core',
    fetchImpl,
    pollIntervalMs: 1,
    scanTimeoutMs: 5000,
  });

  const result = await client.assess('demo', 'outside', {});

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'SCAN_REPORT_MISSING');
});

test('scan status 404 returns SCAN_NOT_FOUND error', async () => {
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/v1/repos/demo/outside')) {
      return jsonResponse(404, { code: 'REPO_NOT_INDEXED' });
    }
    if (url.endsWith('/api/v1/scans') && options.method === 'POST') {
      return jsonResponse(202, scan('scan-5', 'queued'));
    }
    return jsonResponse(404, { code: 'SCAN_NOT_FOUND', detail: 'scan expired' });
  };
  const client = new StarGuardClient({ baseUrl: 'http://core', fetchImpl, pollIntervalMs: 1 });

  const result = await client.assess('demo', 'outside', {});

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'SCAN_NOT_FOUND');
  assert.equal(result.http_status, 404);
});

test('scan timeout returns scanning snapshot', async () => {
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/v1/repos/demo/outside')) {
      return jsonResponse(404, { code: 'REPO_NOT_INDEXED' });
    }
    if (url.endsWith('/api/v1/scans') && options.method === 'POST') {
      return jsonResponse(202, scan('scan-6', 'queued'));
    }
    return jsonResponse(200, scan('scan-6', 'running', { hours_done: 1 }));
  };
  const client = new StarGuardClient({
    baseUrl: 'http://core',
    fetchImpl,
    pollIntervalMs: 1,
    scanTimeoutMs: 5,
  });

  const result = await client.assess('demo', 'outside', {});

  assert.equal(result.status, 'scanning');
  assert.equal(result.scan_id, 'scan-6');
  assert.equal(result.scan.status, 'running');
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

test('history and preview calls use expected URLs', async () => {
  const urls = [];
  const client = new StarGuardClient({
    baseUrl: 'http://core',
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse(200, {});
    },
  });

  await client.getRepoHistory('demo', 'repo');
  await client.getRepoHistory('demo', 'repo', 30);
  await client.getPreview('demo', 'repo');

  assert.equal(urls[0], 'http://core/api/v1/repos/demo/repo/history');
  assert.equal(urls[1], 'http://core/api/v1/repos/demo/repo/history?days=30');
  assert.equal(urls[2], 'http://core/api/v1/preview/demo/repo');
});

test('batch and index calls use expected payloads', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('/api/v1/repos/batch')) {
      return jsonResponse(200, []);
    }
    return jsonResponse(200, { repos: [] });
  };
  const client = new StarGuardClient({ baseUrl: 'http://core', fetchImpl });

  const batch = await client.batchSummaries(['a/one', 'b/two'], 3);
  await client.listIndexedRepos();
  await client.listIndexedRepos({
    limit: 5,
    existingOnly: false,
    withScore: true,
    maxLevel: 'low',
  });

  assert.equal(JSON.parse(requests[0].options.body).repos.length, 2);
  assert.ok(Array.isArray(batch.data));

  assert.match(requests[1].url, /limit=1000/);
  assert.doesNotMatch(requests[1].url, /existing_only/);
  assert.doesNotMatch(requests[1].url, /with_score/);
  assert.doesNotMatch(requests[1].url, /max_level/);

  assert.match(requests[2].url, /limit=5/);
  assert.match(requests[2].url, /existing_only=false/);
  assert.match(requests[2].url, /with_score=true/);
  assert.match(requests[2].url, /max_level=low/);
});

test('startScan sends source only when supplied', async () => {
  const bodies = [];
  const client = new StarGuardClient({
    baseUrl: 'http://core',
    fetchImpl: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return jsonResponse(202, scan('scan-7', 'queued'));
    },
  });

  await client.startScan('demo', 'repo', 6);
  await client.startScan('demo', 'repo', 6, 'archive');

  assert.deepEqual(bodies[0], { owner: 'demo', name: 'repo', hours: 6 });
  assert.deepEqual(bodies[1], { owner: 'demo', name: 'repo', hours: 6, source: 'archive' });
});

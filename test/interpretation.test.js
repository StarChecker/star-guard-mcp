import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretReport, interpretScanFailure } from '../src/interpretation.js';

const baseReport = {
  repo: { full_name: 'demo/farm' },
  window: { from: '2026-11-10T07:00:00Z', to: '2026-11-10T10:00:00Z', hours: 3 },
  stats: { stars: 45, forks: 12, pushes: 70, issues: 18, pull_requests: 22, unique_actors: 38 },
  score: {
    score: 10,
    level: 'low',
    verdict: 'Рост выглядит органичным.',
    confidence: 0.9,
    insufficient_data: false,
    mocked: false,
    checks: [],
  },
  archive: { hours_requested: 3, hours_loaded: 3, missing_hours: [], parse_errors: 0 },
  source: { type: 'gh_archive' },
};

test('healthy report maps to use recommendation', () => {
  const result = interpretReport(baseReport);
  assert.equal(result.interpretation.category, 'healthy');
  assert.equal(result.interpretation.recommendation, 'use');
  assert.equal(result.score, 10);
});

test('high score maps to suspicious and collects active check summaries', () => {
  const report = structuredClone(baseReport);
  report.score.score = 72;
  report.score.level = 'high';
  report.score.checks = [
    { id: 'actor_overlap', active: true, score: 0.8, summary: 'Пересечение аккаунтов' },
    { id: 'burst', active: true, score: 0.5, summary: 'Пик звёзд' },
    { id: 'circadian', active: false, score: 1, summary: 'Не участвует' },
  ];
  const result = interpretReport(report);
  assert.equal(result.interpretation.category, 'suspicious');
  assert.equal(result.interpretation.recommendation, 'review_before_use');
  assert.ok(result.interpretation.reasons.includes('Пересечение аккаунтов'));
  assert.ok(result.interpretation.reasons.includes('Пик звёзд'));
  assert.ok(!result.interpretation.reasons.includes('Не участвует'));
});

test('insufficient data never claims healthy', () => {
  const report = structuredClone(baseReport);
  report.score.score = 0;
  report.score.insufficient_data = true;
  report.score.level = 'low';
  const result = interpretReport(report);
  assert.equal(result.interpretation.category, 'insufficient_data');
  assert.equal(result.interpretation.recommendation, 'insufficient_data');
  assert.equal(result.interpretation.confidence, 'low');
});

test('mock and missing archive produce caveats', () => {
  const report = structuredClone(baseReport);
  report.score.mocked = true;
  report.archive.missing_hours = ['2026-11-10T08:00:00Z'];
  report.archive.parse_errors = 2;
  const result = interpretReport(report);
  assert.equal(result.interpretation.confidence, 'medium');
  assert.ok(result.interpretation.caveats.some((c) => c.includes('mock')));
  assert.ok(result.interpretation.caveats.some((c) => c.includes('GH Archive')));
});

test('github_api source adds account-checks caveat and evidence.source', () => {
  const report = structuredClone(baseReport);
  report.source = { type: 'github_api' };
  const result = interpretReport(report);
  assert.equal(result.evidence.source, 'github_api');
  assert.ok(result.interpretation.caveats.some((c) => c.includes('GitHub')));
  assert.equal(result.interpretation.category, 'healthy');
});

test('gh_archive source does not add the GitHub caveat', () => {
  const result = interpretReport(structuredClone(baseReport));
  assert.equal(result.evidence.source, 'gh_archive');
  assert.ok(!result.interpretation.caveats.some((c) => c.includes('истории GitHub')));
});

test('partial archive coverage adds caveat when missing_hours is empty', () => {
  const report = structuredClone(baseReport);
  report.archive.hours_requested = 6;
  report.archive.hours_loaded = 4;
  const result = interpretReport(report);
  assert.ok(result.interpretation.caveats.some((c) => c.includes('4 из 6')));
});

test('missing_hours suppresses the duplicate coverage caveat', () => {
  const report = structuredClone(baseReport);
  report.archive.hours_requested = 6;
  report.archive.hours_loaded = 4;
  report.archive.missing_hours = ['2026-11-10T08:00:00Z', '2026-11-10T09:00:00Z'];
  const result = interpretReport(report);
  const archiveCaveats = result.interpretation.caveats.filter((c) => c.includes('GH Archive'));
  assert.equal(archiveCaveats.length, 1);
  assert.ok(archiveCaveats[0].includes('2 час'));
});

test('legacy report without source keeps the old output', () => {
  const report = structuredClone(baseReport);
  delete report.source;
  const result = interpretReport(report);
  assert.equal(result.evidence.source, null);
  assert.deepEqual(result.interpretation.caveats, []);
});

test('scan failure reads new ScanDto snake_case fields', () => {
  const result = interpretScanFailure({
    id: 'scan-1',
    status: 'failed',
    error_code: 'ARCHIVE_UNAVAILABLE',
    error_message: 'GH Archive недоступен',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.scan_id, 'scan-1');
  assert.equal(result.error_code, 'ARCHIVE_UNAVAILABLE');
  assert.equal(result.error_message, 'GH Archive недоступен');
});

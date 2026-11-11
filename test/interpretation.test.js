import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretReport } from '../src/interpretation.js';

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

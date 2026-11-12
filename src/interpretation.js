/**
 * Детерминированная трактовка отчёта Star Guard.
 * Никаких внешних LLM-запросов: только score/level/verdict/checks из API.
 */

const CATEGORY_BY_LEVEL = {
  low: 'healthy',
  medium: 'borderline',
  high: 'suspicious',
  critical: 'critical',
};

const RECOMMENDATION_BY_CATEGORY = {
  healthy: 'use',
  borderline: 'use_with_caution',
  suspicious: 'review_before_use',
  critical: 'avoid',
  insufficient_data: 'insufficient_data',
};

export function interpretReport(report) {
  const score = report?.score ?? {};
  const checks = Array.isArray(score.checks) ? score.checks : [];
  const insufficient = score.insufficient_data === true ||
    (!Number.isFinite(score.score) && !score.level);
  const level = insufficient ? 'insufficient_data' : (score.level ?? 'insufficient_data');
  const category = insufficient
    ? 'insufficient_data'
    : (CATEGORY_BY_LEVEL[level] ?? 'borderline');

  const reasons = [];
  if (typeof score.verdict === 'string' && score.verdict.trim()) {
    reasons.push(score.verdict.trim());
  }
  for (const check of checks) {
    if (!check?.active || (check.score ?? 0) < 0.3) {
      continue;
    }
    const text = (check.summary || check.title || check.id || '').trim();
    if (text && !reasons.includes(text)) {
      reasons.push(text);
    }
  }

  const sourceType = report?.source?.type ?? null;
  const caveats = [];
  if (score.mocked) {
    caveats.push('Часть проверок работает в mock-режиме — оценка неполная.');
  }
  if (insufficient) {
    caveats.push('Недостаточно данных для уверенной оценки.');
  }
  if (sourceType === 'github_api') {
    caveats.push('Оценка по истории GitHub: проверки по аккаунтам (свежие аккаунты, пересечение акторов) недоступны.');
  }
  const missingHours = report?.archive?.missing_hours?.length ?? 0;
  if (missingHours > 0) {
    caveats.push(`В окне отсутствуют ${missingHours} час(ов) GH Archive.`);
  }
  const requestedHours = report?.archive?.hours_requested;
  const loadedHours = report?.archive?.hours_loaded;
  if (missingHours === 0
      && Number.isFinite(requestedHours) && requestedHours > 0
      && Number.isFinite(loadedHours) && loadedHours < requestedHours) {
    caveats.push(`Загружено ${loadedHours} из ${requestedHours} час(ов) GH Archive — покрытие окна неполное.`);
  }
  const parseErrors = report?.archive?.parse_errors ?? 0;
  if (parseErrors > 0) {
    caveats.push(`Ошибок разбора строк GH Archive: ${parseErrors}.`);
  }

  return {
    repository: report?.repo?.full_name ?? null,
    score: score.score ?? null,
    level,
    verdict: score.verdict ?? null,
    interpretation: {
      category,
      confidence: insufficient ? 'low' : score.mocked ? 'medium' : confidenceLabel(score.confidence),
      reasons: reasons.slice(0, 5),
      recommendation: RECOMMENDATION_BY_CATEGORY[category] ?? 'review_before_use',
      caveats,
    },
    evidence: {
      window: report?.window ?? null,
      stats: report?.stats ?? null,
      source: sourceType,
      checks: checks.map((check) => ({
        id: check.id,
        title: check.title,
        score: check.score,
        confidence: check.confidence,
        active: check.active,
      })),
    },
    disclaimer: 'Это признаки, а не доказательство накрутки. Решение об использовании библиотеки принимает человек.',
  };
}

export function interpretScanFailure(scan) {
  return {
    status: 'failed',
    scan_id: scan?.id ?? null,
    error_code: scan?.error_code ?? scan?.errorCode ?? 'SCAN_FAILED',
    error_message: scan?.error_message ?? scan?.errorMessage ?? 'Скан завершился ошибкой',
  };
}

function confidenceLabel(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'unknown';
  }
  if (value >= 0.8) {
    return 'high';
  }
  if (value >= 0.5) {
    return 'medium';
  }
  return 'low';
}

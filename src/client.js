import { setTimeout as sleep } from 'node:timers/promises';
import { interpretReport, interpretScanFailure } from './interpretation.js';

/** Ошибки GitHub-источника, при которых имеет смысл повторить проверку по GH Archive. */
const GITHUB_FALLBACK_CODES = new Set([
  'GITHUB_TOKEN_REQUIRED',
  'GITHUB_TOKEN_INVALID',
  'GITHUB_RATE_LIMITED',
  'GITHUB_UNAVAILABLE',
  'GITHUB_HISTORY_NOT_READY',
]);

export class StarGuardError extends Error {
  constructor(message, { status = 0, code = 'ERROR', body = null } = {}) {
    super(message);
    this.name = 'StarGuardError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * HTTP-клиент к Star Guard. Единственный внешний сервис, с которым работает MCP.
 */
export class StarGuardClient {
  constructor({
    baseUrl = process.env.STAR_GUARD_API_URL ?? 'http://localhost:8080',
    fetchImpl = globalThis.fetch,
    scanTimeoutMs = envNumber('STAR_GUARD_SCAN_TIMEOUT_MS', 60000),
    pollIntervalMs = envNumber('STAR_GUARD_POLL_INTERVAL_MS', 1500),
    requestTimeoutMs = envNumber('STAR_GUARD_REQUEST_TIMEOUT_MS', 30000),
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch is not available; use Node.js 20+');
    }
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.scanTimeoutMs = scanTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async getReport(owner, name, hours, days) {
    return this.request(`/api/v1/repos/${seg(owner)}/${seg(name)}${query({ hours, days })}`);
  }

  async getRepoHistory(owner, name, days) {
    return this.request(`/api/v1/repos/${seg(owner)}/${seg(name)}/history${query({ days })}`);
  }

  async getPreview(owner, name) {
    return this.request(`/api/v1/preview/${seg(owner)}/${seg(name)}`);
  }

  async startScan(owner, name, hours, source) {
    return this.request('/api/v1/scans', {
      method: 'POST',
      body: { owner, name, ...(hours == null ? {} : { hours }), ...(source == null ? {} : { source }) },
    });
  }

  async getScan(scanId) {
    return this.request(`/api/v1/scans/${seg(scanId)}`);
  }

  async listIndexedRepos({ limit = 1000, existingOnly, withScore, maxLevel } = {}) {
    return this.request(`/api/v1/index/repos${query({
      limit,
      existing_only: existingOnly,
      with_score: withScore,
      max_level: maxLevel,
    })}`);
  }

  async batchSummaries(repos, hours) {
    return this.request('/api/v1/repos/batch', {
      method: 'POST',
      body: { repos, ...(hours == null ? {} : { hours }) },
    });
  }

  async getBadge(owner, name, hours) {
    return this.request(`/api/v1/badge/${seg(owner)}/${seg(name)}${hoursQuery(hours)}`);
  }

  /**
   * Проверка библиотеки: индекс/GitHub → мгновенный отчёт; вне индекса → скан и polling.
   */
  async assess(owner, name, {
    hours,
    days,
    waitForScan = true,
    scanTimeoutMs = this.scanTimeoutMs,
    pollIntervalMs = this.pollIntervalMs,
  } = {}) {
    const report = await this.getReport(owner, name, hours, days);
    if (report.status === 200) {
      return interpretReport(report.data);
    }

    const code = report.data?.code;
    const scanOptions = { hours, waitForScan, scanTimeoutMs, pollIntervalMs };
    if (code === 'REPO_NOT_INDEXED') {
      return this.startScanAndWait(owner, name, {
        ...scanOptions,
        message: 'Репозиторий вне индекса. Скан запущен, результат будет доступен позже.',
      });
    }

    if (GITHUB_FALLBACK_CODES.has(code)) {
      // GitHub-источник недоступен (нет токена, лимит, сбой API) — пробуем GH Archive.
      return this.startScanAndWait(owner, name, {
        ...scanOptions,
        source: 'archive',
        message: 'GitHub-источник недоступен. Скан GH Archive запущен, результат будет доступен позже.',
      });
    }

    if (code === 'INDEX_NOT_READY') {
      return {
        status: 'index_not_ready',
        code,
        message: report.data?.detail ?? 'Индекс Star Guard ещё прогревается. Попробуйте позже.',
      };
    }
    if (code === 'REPO_NOT_FOUND_IN_WINDOW') {
      return {
        status: 'no_data',
        code,
        message: report.data?.detail ?? 'В GH Archive нет событий репозитория за запрошенное окно.',
      };
    }
    if (code === 'REPO_NOT_FOUND_ON_GITHUB') {
      return {
        status: 'repo_not_found',
        code,
        message: report.data?.detail ?? 'Репозиторий удалён или приватный по данным GitHub.',
      };
    }
    return {
      status: 'error',
      http_status: report.status,
      code: code ?? 'HTTP_ERROR',
      message: report.data?.detail ?? 'Star Guard API вернул ошибку',
    };
  }

  async startScanAndWait(owner, name, {
    hours,
    source,
    waitForScan,
    scanTimeoutMs,
    pollIntervalMs,
    message,
  }) {
    const started = await this.startScan(owner, name, hours, source);
    const scanId = started.data?.id ?? started.data?.scan_id ?? null;
    if (!scanId) {
      throw new StarGuardError('Star Guard did not return scan id', {
        status: started.status,
        code: 'SCAN_START_FAILED',
        body: started.data,
      });
    }
    if (!waitForScan) {
      return {
        status: 'scanning',
        scan_id: scanId,
        source: source ?? null,
        scan: started.data,
        message,
      };
    }
    return this.waitForScan(scanId, { scanTimeoutMs, pollIntervalMs });
  }

  async waitForScan(scanId, { scanTimeoutMs, pollIntervalMs }) {
    const deadline = Date.now() + scanTimeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      const response = await this.getScan(scanId);
      if (response.status !== 200) {
        return {
          status: 'error',
          scan_id: scanId,
          http_status: response.status,
          code: response.data?.code ?? 'SCAN_STATUS_ERROR',
          message: response.data?.detail ?? 'Не удалось получить статус скана',
        };
      }
      last = response.data;
      if (last?.status === 'done') {
        if (!last.report) {
          return {
            status: 'error',
            scan_id: scanId,
            code: 'SCAN_REPORT_MISSING',
            message: 'Скан завершён, но Star Guard не вернул отчёт.',
          };
        }
        return {
          ...interpretReport(last.report),
          scan_id: scanId,
          status: 'done',
        };
      }
      if (last?.status === 'failed') {
        return interpretScanFailure(last);
      }
    }
    return {
      status: 'scanning',
      scan_id: scanId,
      scan: last,
      message: `Скан ещё выполняется (timeout ${scanTimeoutMs} мс). Запросите статус позже.`,
    };
  }

  async request(path, { method = 'GET', body = undefined, timeoutMs = this.requestTimeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }
      return { status: response.status, data };
    } catch (error) {
      throw new StarGuardError(
        `Star Guard API недоступен (${this.baseUrl}): ${error.message}`,
        { code: 'API_UNREACHABLE' },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function seg(value) {
  if (value == null || String(value).trim() === '') {
    throw new Error('owner, name and scan id must not be empty');
  }
  return encodeURIComponent(String(value).trim());
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

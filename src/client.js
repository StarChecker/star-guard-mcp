import { setTimeout as sleep } from 'node:timers/promises';
import { interpretReport, interpretScanFailure } from './interpretation.js';

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

  async getReport(owner, name, hours) {
    return this.request(`/api/v1/repos/${seg(owner)}/${seg(name)}${hoursQuery(hours)}`);
  }

  async startScan(owner, name, hours) {
    return this.request('/api/v1/scans', {
      method: 'POST',
      body: { owner, name, ...(hours == null ? {} : { hours }) },
    });
  }

  async getScan(scanId) {
    return this.request(`/api/v1/scans/${seg(scanId)}`);
  }

  async listIndexedRepos(limit = 1000) {
    return this.request(`/api/v1/index/repos?limit=${encodeURIComponent(limit)}`);
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
   * Проверка библиотеки: индекс → мгновенный отчёт; вне индекса → скан и polling.
   */
  async assess(owner, name, {
    hours,
    waitForScan = true,
    scanTimeoutMs = this.scanTimeoutMs,
    pollIntervalMs = this.pollIntervalMs,
  } = {}) {
    const report = await this.getReport(owner, name, hours);
    if (report.status === 200) {
      return interpretReport(report.data);
    }

    const code = report.data?.code;
    if (code === 'REPO_NOT_INDEXED') {
      const started = await this.startScan(owner, name, hours);
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
          scan: started.data,
          message: 'Репозиторий вне индекса. Скан запущен, результат будет доступен позже.',
        };
      }
      return this.waitForScan(scanId, { scanTimeoutMs, pollIntervalMs });
    }

    if (code === 'INDEX_NOT_READY') {
      return {
        status: 'index_not_ready',
        code,
        message: 'Индекс Star Guard ещё прогревается. Попробуйте позже.',
      };
    }
    if (code === 'REPO_NOT_FOUND_IN_WINDOW') {
      return {
        status: 'no_data',
        code,
        message: 'В GH Archive нет событий репозитория за запрошенное окно.',
      };
    }
    return {
      status: 'error',
      http_status: report.status,
      code: code ?? 'HTTP_ERROR',
      message: report.data?.detail ?? 'Star Guard API вернул ошибку',
    };
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
      if (last?.status === 'done' && last.report) {
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

function hoursQuery(hours) {
  return hours == null ? '' : `?hours=${encodeURIComponent(hours)}`;
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

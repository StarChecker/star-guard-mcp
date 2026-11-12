# Архитектура Star Guard MCP

## Назначение

MCP-сервер даёт Claude Code инструмент для проверки GitHub-репозитория перед
использованием open-source библиотеки. Сервер не хранит данные и не считает
score сам: он вызывает готовый REST API Star Guard, а затем детерминированно
интерпретирует ответ.

**Внешние LLM не используются.** Нет запросов в Anthropic/OpenAI и другие
сервисы; трактовка строится по `score`, `level`, `verdict` и `checks`.

## Компоненты

```text
Claude Code
    │  MCP stdio: newline-delimited JSON-RPC 2.0
    ▼
src/index.js
    │
    ▼
McpServer (src/mcp-server.js)
    │  initialize / tools/list / tools/call / ping / shutdown
    ▼
Tools (src/tools.js)
    │  assess_dependency, get_repo_report, start_scan, get_scan,
    │  list_indexed_repos, batch_summaries, get_badge
    ├──────────────► StarGuardClient (src/client.js)
    │                   │  HTTP
    │                   ▼
    │                Star Guard REST API
    │                   │  report / scan / index / badges
    │                   ▼
    │                GH Archive + scoring
    ▼
Interpretation (src/interpretation.js)
    │  level → category / recommendation
    ▼
Результат в Claude Code
```

## Поток `assess_dependency`

```text
1. GET /api/v1/repos/{owner}/{name}?hours=N
2. 200 → interpretReport(report)
3. 404 REPO_NOT_INDEXED →
      POST /api/v1/scans
      polling GET /api/v1/scans/{id}
      done → interpretReport(report)
      failed → interpretScanFailure
      timeout → status=scanning + scan_id
4. 404 REPO_NOT_FOUND_IN_WINDOW → status=no_data
5. 503 INDEX_NOT_READY → status=index_not_ready
6. сеть/5xx → структурированная ошибка API_UNREACHABLE
```

## Детерминированная трактовка

`interpretation.js` не вызывает LLM и не делает сетевых запросов:

| `score.level` | category | recommendation |
|---------------|----------|----------------|
| low | healthy | use |
| medium | borderline | use_with_caution |
| high | suspicious | review_before_use |
| critical | critical | avoid |
| `insufficient_data` | insufficient_data | insufficient_data |

Причины: `score.verdict` + `checks[].summary` активных проверок, до 5 штук.
Caveats: `mocked`, `missing_hours`, `parse_errors`, недостаточный confidence.
Дисклеймер: «Это признаки, а не доказательство накрутки».

## MCP-протокол

- Транспорт: stdio, по одному JSON-RPC объекту на строку.
- Поддерживаемые версии: `2024-11-05`, `2025-03-26`, `2025-06-18`.
- `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`,
  `shutdown`, `exit`.
- stdout — только JSON-RPC; диагностика — в stderr.
- Ошибка инструмента возвращается как `result.isError=true`, а не падение процесса.

## Конфигурация

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `STAR_GUARD_API_URL` | `http://localhost:8080` | адрес Star Guard |
| `STAR_GUARD_SCAN_TIMEOUT_MS` | `60000` | сколько ждать скан |
| `STAR_GUARD_POLL_INTERVAL_MS` | `1500` | интервал polling |
| `STAR_GUARD_REQUEST_TIMEOUT_MS` | `30000` | таймаут HTTP-запроса |

## Ограничения

- Один stdio-клиент; Streamable HTTP не входит в PoC.
- `ScanService` в Star Guard хранит задачи in-memory; при нескольких инстансах
  нужен общий store или sticky routing.
- Cold-скан репозитория вне индекса может занять десятки секунд.
- MCP не проверяет подлинность данных: он доверяет Star Guard и явно показывает
  `mocked`/покрытие архива.

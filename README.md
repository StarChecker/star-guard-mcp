# Star Guard MCP

MCP-сервер для **Claude Code**, который проверяет GitHub-репозиторий перед
использованием open-source библиотеки. Он вызывает REST API
[Star Guard](https://github.com/StarChecker/star-guard) и возвращает:

- `score` и `level` (low / medium / high / critical);
- детерминированную трактовку: `healthy`, `borderline`, `suspicious`,
  `critical`, `insufficient_data`;
- причины и рекомендацию (`use`, `use_with_caution`, `review_before_use`, `avoid`);
- оговорки о покрытии: mock-проверки, пропущенные часы архива, ошибки разбора.

**Внешние LLM не используются.** Никаких запросов в Anthropic/OpenAI и другие
сервисы: трактовка строится по порогам из ответа Star Guard. MCP-сервер общается
только с Star Guard по `STAR_GUARD_API_URL`.

## Требования

- Node.js **20+** (проверено на Node 24)
- запущенный Star Guard, например `http://localhost:8080`
- внешних npm-зависимостей нет — `npm install` не нужен

## Запуск

```bash
node src/index.js
```

Переменные окружения:

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `STAR_GUARD_API_URL` | `http://localhost:8080` | адрес Star Guard |
| `STAR_GUARD_SCAN_TIMEOUT_MS` | `60000` | сколько ждать скан репозитория вне индекса |
| `STAR_GUARD_POLL_INTERVAL_MS` | `1500` | интервал polling статуса скана |
| `STAR_GUARD_REQUEST_TIMEOUT_MS` | `30000` | таймаут HTTP-запроса к Star Guard |

## Claude Code

```bash
claude mcp add star-guard-mcp -- node /absolute/path/to/star-guard-mcp/src/index.js
```

С переменными окружения:

```bash
STAR_GUARD_API_URL=http://localhost:8080 \
  claude mcp add star-guard-mcp -- node /absolute/path/to/star-guard-mcp/src/index.js
```

Пример `.mcp.json`:

```json
{
  "mcpServers": {
    "star-guard-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/star-guard-mcp/src/index.js"],
      "env": { "STAR_GUARD_API_URL": "http://localhost:8080" }
    }
  }
}
```

## Инструменты

| Tool | Назначение |
|------|------------|
| `assess_dependency` | главный сценарий: report → при `REPO_NOT_INDEXED` запускает скан и ждёт/возвращает `scan_id`, затем трактовка |
| `get_repo_report` | сырой отчёт Star Guard |
| `start_scan` | запуск фонового скана GH Archive |
| `get_scan` | статус/результат скана |
| `list_indexed_repos` | репозитории, доступные без скана |
| `batch_summaries` | сводки до 50 репозиториев |
| `get_badge` | endpoint-badge для shields.io |

Пример ответа `assess_dependency`:

```json
{
  "repository": "demo/farm-target",
  "score": 86,
  "level": "critical",
  "verdict": "Сильные признаки накрутки.",
  "interpretation": {
    "category": "critical",
    "confidence": "high",
    "reasons": ["30 аккаунтов ставят звёзды 5 репозиториям", "пик 31 звезда за 10 минут"],
    "recommendation": "avoid",
    "caveats": ["2 часа архива отсутствуют"]
  },
  "evidence": { "window": { "hours": 6 }, "stats": { "stars": 120 } },
  "disclaimer": "Это признаки, а не доказательство накрутки."
}
```

Для репозитория вне индекса Star Guard вернёт `REPO_NOT_INDEXED`; MCP-сервер
запустит `POST /api/v1/scans` и будет опрашивать `GET /api/v1/scans/{id}`.
Если скан не успел — вернётся `status: "scanning"` с `scan_id`; повторный вызов
`assess_dependency` или `get_scan` покажет результат.

## Категории и рекомендации

| score | level | category | recommendation |
|-------|-------|----------|----------------|
| 0–29 | low | healthy | use |
| 30–59 | medium | borderline | use_with_caution |
| 60–84 | high | suspicious | review_before_use |
| 85–100 | critical | critical | avoid |
| — | insufficient_data | insufficient_data | insufficient_data |

Категории вычисляются по `level`, а не по свободному тексту; LLM в этом не
участвует.

## Разработка

```bash
node --test
```

Тесты не требуют сети: HTTP-клиент проверяется на fake `fetch`, MCP-протокол —
через `McpServer` и `runStdio` с in-memory streams.

## Ограничения

- MCP-сервер однопоточный по stdio; для нескольких клиентов нужен отдельный
  Streamable HTTP-транспорт (не входит в этот PoC).
- Cold-скан произвольного репозитория в Star Guard асинхронный и может занять
  десятки секунд — MCP не блокирует клиента дольше `STAR_GUARD_SCAN_TIMEOUT_MS`.
- Пока проверки Star Guard в mock-режиме, трактовка помечается caveat-ом;
  для демо включайте реальные проверки в Star Guard.
- Это признаки, а не доказательство накрутки; решение об использовании
  библиотеки принимает человек.

# MCP-инструменты

Все инструменты вызывают Star Guard REST API. Внешних LLM-запросов нет.
Ошибки инструмента возвращаются с `isError: true`; сервер продолжает работать.

## `assess_dependency`

Главный сценарий: проверить библиотеку перед подключением.

**Аргументы**

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `owner` | string | да | GitHub owner |
| `name` | string | да | имя репозитория |
| `hours` | integer 1..24 | нет | окно GH Archive |
| `wait_for_scan` | boolean | нет (true) | ждать скан, если репозиторий вне индекса |
| `scan_timeout_ms` | integer 1000..600000 | нет | максимальное ожидание скана |

**Результат**

```json
{
  "repository": "demo/farm-target",
  "score": 86,
  "level": "critical",
  "verdict": "Сильные признаки накрутки.",
  "interpretation": {
    "category": "critical",
    "confidence": "high",
    "reasons": ["30 аккаунтов ставят звёзды 5 репозиториям"],
    "recommendation": "avoid",
    "caveats": ["Часть проверок работает в mock-режиме — оценка неполная."]
  },
  "evidence": {
    "window": { "hours": 3 },
    "stats": { "stars": 120, "forks": 1, "pushes": 2 }
  },
  "disclaimer": "Это признаки, а не доказательство накрутки. Решение об использовании библиотеки принимает человек."
}
```

**Особые статусы вместо отчёта:**

| status | Причина |
|--------|---------|
| `scanning` | репозиторий вне индекса, скан не успел; вернутся `scan_id` и текущий статус |
| `no_data` | в GH Archive нет событий за окно |
| `index_not_ready` | индекс Star Guard ещё прогревается |
| `failed` | скан завершился ошибкой |
| `error` | прочая ошибка API |

## `get_repo_report`

Сырой отчёт Star Guard: `repo`, `window`, `stats`, `score`, `archive`,
`stars_timeline`. Аргументы: `owner`, `name`, `hours?`.

## `start_scan`

`POST /api/v1/scans` → `ScanDto` с `id` и `status`. Аргументы: `owner`, `name`,
`hours?`. Используйте для явного запуска скана вне индекса.

## `get_scan`

`GET /api/v1/scans/{id}`. Аргумент `scan_id`. Статусы: `queued`, `running`,
`done`, `failed`. При `done` в ответе есть `report`.

## `list_indexed_repos`

`GET /api/v1/index/repos?limit=N`. Аргумент `limit` (1..5000, по умолчанию 1000).
Возвращает `window`, `built_at`, `hours_loaded`, `missing_hours`, `parse_errors`
и список `rank/owner/name/full_name/stars`.

## `batch_summaries`

`POST /api/v1/repos/batch`. Аргументы:

- `repos` — массив `owner/name`, 1..50;
- `hours?`.

Возвращает короткие сводки со `status: ok | not_indexed | no_data |
index_not_ready | error`, `score`, `level`, `verdict`, `stars`.

## `get_badge`

`GET /api/v1/badge/{owner}/{name}` — JSON для shields.io endpoint badge.
Аргументы: `owner`, `name`, `hours?`.

## Пример вызова из Claude Code

```text
Используй star-guard-mcp assess_dependency для demo/farm-target,
объясни recommendation и перечисли caveats.
```

Ожидаемо: MCP вернёт структуру выше; Claude Code перескажет её пользователю.

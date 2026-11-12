# MCP-инструменты

Все инструменты вызывают Star Guard REST API. Внешних LLM-запросов нет.
Ошибки инструмента возвращаются с `isError: true`; сервер продолжает работать.

API описан в терминах актуальной ветки `main` Star Guard: JSON — snake_case,
кроме бейджа; отчёт выбирает источник сам (`app.report.source=auto`).

## `assess_dependency`

Главный сценарий: проверить библиотеку перед подключением.

**Аргументы**

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `owner` | string | да | GitHub owner |
| `name` | string | да | имя репозитория |
| `hours` | integer 1..24 | нет | окно GH Archive |
| `days` | integer 1..90 | нет | окно истории GitHub; сервис может ограничить `app.github.history.max-days` |
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
    "stats": { "stars": 120, "forks": 1, "pushes": 2 },
    "source": "gh_archive"
  },
  "disclaimer": "Это признаки, а не доказательство накрутки. Решение об использовании библиотеки принимает человек."
}
```

`evidence.source` — чем построен отчёт:

| `source` | Что это |
|----------|---------|
| `gh_archive_index` | индекс GH Archive (репозиторий в top-N) |
| `gh_archive` | прямой разбор GH Archive |
| `github_api` | дневная история GitHub; проверок по аккаунтам нет |

`hours` и `days` можно передать вместе: сервер использует то окно, которое
соответствует выбранному источнику.

**Особые статусы вместо отчёта:**

| status | Причина |
|--------|---------|
| `scanning` | репозиторий вне индекса, скан не успел; вернутся `scan_id` и текущий статус |
| `no_data` | в GH Archive нет событий за окно (`REPO_NOT_FOUND_IN_WINDOW`) |
| `index_not_ready` | индекс Star Guard ещё прогревается или отключён |
| `repo_not_found` | репозиторий удалён или приватный (`REPO_NOT_FOUND_ON_GITHUB`) |
| `failed` | скан завершился ошибкой |
| `error` | прочая ошибка API (`ARCHIVE_UNAVAILABLE`, `INVALID_REQUEST`, …) |

**Автопереход на скан.** Если сервер вернул `REPO_NOT_INDEXED`, MCP запускает
скан и ждёт результат. Если GitHub-источник недоступен
(`GITHUB_TOKEN_REQUIRED`, `GITHUB_TOKEN_INVALID`, `GITHUB_RATE_LIMITED`,
`GITHUB_UNAVAILABLE`, `GITHUB_HISTORY_NOT_READY`), MCP автоматически запускает
скан GH Archive (`source=archive`) и ждёт его. При `ARCHIVE_UNAVAILABLE` скан
не запускается: без архива он тоже не поможет.

## `get_repo_report`

Сырой отчёт Star Guard: `repo`, `window`, `stats`, `score`, `archive`,
`stars_timeline`, `source`. Аргументы: `owner`, `name`, `hours?`, `days?`.

## `get_repo_history`

`GET /api/v1/repos/{owner}/{name}/history` — анализ любого публичного
репозитория по дневной истории GitHub: звёзды, форки, issues, PR, коммиты.
Нужен `GITHUB_TOKEN`. Аргумент: `days?` (1..90).

Проверки по аккаунтам в этом режиме недоступны: GitHub не отдаёт, кто поставил
звёзды. Ошибки API: `400 INVALID_REQUEST`, `404 REPO_NOT_FOUND_ON_GITHUB`,
`503 GITHUB_TOKEN_REQUIRED | GITHUB_RATE_LIMITED | GITHUB_UNAVAILABLE |
GITHUB_HISTORY_NOT_READY`.

## `get_preview`

`GET /api/v1/preview/{owner}/{name}` — базовая статистика GitHub без score:
`description`, `html_url`, `stars`, `forks`, `open_issues`, `watchers`,
`contributors`, `archived`, `fork`, `created_at`, `pushed_at`, `fetched_at`,
`cached`. В ответе `partial: true` и `note` — оценки накрутки здесь нет.

Аргументы: `owner`, `name`. Ошибки: `404 REPO_NOT_FOUND_ON_GITHUB`,
`503 GITHUB_PREVIEW_DISABLED | GITHUB_RATE_LIMITED | GITHUB_TOKEN_INVALID |
GITHUB_UNAVAILABLE`. Часть полей может быть `null`.

## `start_scan`

`POST /api/v1/scans` → 202 `ScanDto` с `id` и `status`. Аргументы: `owner`,
`name`, `hours?`, `source?` (`github` | `archive`; по умолчанию сервис выбирает
сам). `hours` действует только для `source=archive`; GitHub-скан берёт
серверное окно `app.github.history.max-days`. Повторный запрос для того же
репозитория и периода вернёт тот же `id`.

## `get_scan`

`GET /api/v1/scans/{id}`. Аргумент `scan_id`. `ScanDto`:

```json
{
  "id": "0f0b3c2e-...",
  "repo": { "owner": "demo", "name": "farm-target", "full_name": "demo/farm-target" },
  "status": "queued",
  "source": "archive",
  "hours_done": 0,
  "hours_total": 3,
  "created_at": "2026-11-13T00:00:00Z",
  "report": null,
  "error_code": null,
  "error_message": null
}
```

Статусы: `queued`, `running`, `done`, `failed`. При `done` в `report` —
полный отчёт; при `failed` — `error_code` и `error_message`. `hours_done` /
`hours_total` — шаги прогресса, а не всегда часы. Готовый скан живёт 30 минут,
после чего API отвечает `404 SCAN_NOT_FOUND`.

## `list_indexed_repos`

`GET /api/v1/index/repos`. Аргументы:

- `limit` (1..5000, по умолчанию 1000);
- `existing_only` (по умолчанию true) — пропускать удалённые на GitHub;
- `with_score` — добавить `score`/`level`/`verdict` к строкам;
- `max_level` (`low|medium|high|critical`) — оставить уровень не выше
  указанного; подразумевает `with_score`.

Ответ: `window`, `built_at`, `top_n`, `hours_loaded`, `missing_hours`,
`parse_errors`, `skipped_deleted`, `skipped_by_level` и `repos[]` с полями
`rank/owner/name/full_name/stars/exists/score/level/verdict` (`score` и
`verdict` — `null` без `with_score`). В fixture-режиме индекс отключён и
сервис отвечает `503 INDEX_NOT_READY`.

## `batch_summaries`

`POST /api/v1/repos/batch`. Аргументы:

- `repos` — массив `owner/name`, 1..50;
- `hours?`.

Ответ — **массив** в порядке запроса (без обёртки), у каждого элемента свой
`status: ok | not_indexed | no_data | index_not_ready | error` и поля
`full_name`, `score`, `level`, `confidence`, `verdict`, `stars`,
`suspicious_stars`, `mocked` (у не-`ok` — `null`). Скан батч не запускает.

## `get_badge`

`GET /api/v1/badge/{owner}/{name}` — JSON для shields.io endpoint badge:
`schemaVersion`, `label`, `message`, `color`, `cacheSeconds` (camelCase).
Всегда HTTP 200; состояние кодируется текстом (`not tracked`, `warming up`,
`not enough data`, `unavailable`). Аргументы: `owner`, `name`, `hours?`.

## Пример вызова из Claude Code

```text
Используй star-guard-mcp assess_dependency для demo/farm-target,
объясни recommendation и перечисли caveats.
```

Ожидаемо: MCP вернёт структуру выше; Claude Code перескажет её пользователю.

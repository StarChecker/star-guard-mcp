# Star Guard MCP

MCP-сервер для **Claude Code**, который проверяет GitHub-репозиторий перед
использованием open-source библиотеки. Он вызывает REST API
[Star Guard](https://github.com/StarChecker/star-guard) и возвращает:

- `score` и `level` (low / medium / high / critical);
- детерминированную трактовку: `healthy`, `borderline`, `suspicious`,
  `critical`, `insufficient_data`;
- причины и рекомендацию (`use`, `use_with_caution`, `review_before_use`, `avoid`);
- оговорки о покрытии: mock-проверки, пропущенные часы архива, ошибки разбора,
  источник отчёта (`gh_archive_index`, `gh_archive`, `github_api`).

Актуальный Star Guard умеет строить отчёт по истории GitHub (`github_api`):
там есть дневная история звёзд и активность, но нет проверок по аккаунтам —
MCP явно отмечает это caveat-ом.

**Внешние LLM не используются.** Никаких запросов в Anthropic/OpenAI и другие
сервисы: трактовка строится по порогам из ответа Star Guard. MCP-сервер общается
только с Star Guard по `STAR_GUARD_API_URL`.

## Документация

- [docs/mcp.md](docs/mcp.md) — MCP-слой: транспорт, рукопожатие, методы,
  ошибки, подключение и отладка.
- [docs/tools.md](docs/tools.md) — инструменты, аргументы и форматы ответов.
- [docs/architecture.md](docs/architecture.md) — внутреннее устройство и поток
  `assess_dependency`.

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
| `assess_dependency` | главный сценарий: report (`hours`/`days`) → при `REPO_NOT_INDEXED` или ошибках `GITHUB_*` запускает скан и ждёт/возвращает `scan_id`, затем трактовка |
| `get_repo_report` | сырой отчёт Star Guard (`hours?`, `days?`) |
| `get_repo_history` | анализ репозитория по истории GitHub (`days?`, нужен `GITHUB_TOKEN`) |
| `get_preview` | базовая статистика GitHub без score |
| `start_scan` | запуск фонового скана (`hours?`, `source: github \| archive`) |
| `get_scan` | статус/результат скана |
| `list_indexed_repos` | репозитории без скана; фильтры `existing_only`, `with_score`, `max_level` |
| `batch_summaries` | сводки до 50 репозиториев; ответ — массив в порядке запроса |
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
  "evidence": {
    "window": { "hours": 6 },
    "stats": { "stars": 120 },
    "source": "gh_archive"
  },
  "disclaimer": "Это признаки, а не доказательство накрутки."
}
```

Для репозитория вне индекса Star Guard вернёт `REPO_NOT_INDEXED`; MCP-сервер
запустит `POST /api/v1/scans` и будет опрашивать `GET /api/v1/scans/{id}`.
Если GitHub-источник недоступен (`GITHUB_TOKEN_REQUIRED`, `GITHUB_RATE_LIMITED`,
`GITHUB_UNAVAILABLE` и т. п.), MCP автоматически запустит скан GH Archive
(`source=archive`). Скан живёт 30 минут; если он не успел — вернётся
`status: "scanning"` с `scan_id`, повторный вызов `assess_dependency` или
`get_scan` покажет результат. Удалённый или приватный репозиторий даёт
`status: "repo_not_found"`.

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

## Docker

```bash
docker build -t star-guard-mcp .
docker run -i --rm \
  -e STAR_GUARD_API_URL=http://host.docker.internal:8080 \
  star-guard-mcp
```

`-i` обязателен: MCP общается по stdin/stdout. На Linux `localhost` из
контейнера указывает на сам контейнер; для доступа к хосту добавьте
`--add-host=host.docker.internal:host-gateway` (или укажите адрес Star Guard
в сети).

### Публикация в Docker Hub

Workflow [`.github/workflows/docker.yml`](.github/workflows/docker.yml)
запускает тесты, собирает образ через Buildx и пушит его в Docker Hub:

- push в `main` → `latest`, `sha-<short>`;
- тег `v*` (например, `v0.1.0`) → `0.1.0`, `0.1`, `sha-<short>`;
- pull request → только сборка `linux/amd64` без пуша;
- `workflow_dispatch` → как push в `main`.

Основная сборка multi-arch: `linux/amd64` и `linux/arm64`.

Секреты репозитория (Settings → Secrets and variables → Actions):

| Секрет | Значение |
|--------|----------|
| `DOCKERHUB_USERNAME` | логин Docker Hub |
| `DOCKERHUB_TOKEN` | personal access token с правами Read & Write ([Account settings → Personal access tokens](https://hub.docker.com/settings/security)); пароль не используйте |

Имя образа — `<DOCKERHUB_USERNAME>/star-guard-mcp`. Репозиторий на Docker Hub
должен быть **публичным**: создайте его заранее (Create repository →
Visibility: Public) либо после первого push переключите видимость в
Settings → Visibility. Публичным он делается только этой настройкой — сам по
себе push видимость не гарантирует.

Использование опубликованного образа:

```bash
docker pull <dockerhub-user>/star-guard-mcp:latest
```

```json
{
  "mcpServers": {
    "star-guard-mcp": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "STAR_GUARD_API_URL=http://host.docker.internal:8080",
        "<dockerhub-user>/star-guard-mcp:latest"
      ]
    }
  }
}
```

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
- Отчёт `github_api` строится по дневной истории GitHub: проверок по аккаунтам
  в нём нет, MCP отмечает это caveat-ом.
- Это признаки, а не доказательство накрутки; решение об использовании
  библиотеки принимает человек.

# MCP-слой Star Guard

Документ описывает, как `star-guard-mcp` общается с MCP-клиентом: транспорт,
рукопожатие, поддерживаемые методы, формат ответов и ошибок. Внутреннее
устройство — в [architecture.md](architecture.md), описание инструментов — в
[tools.md](tools.md).

## Что это

`star-guard-mcp` — MCP-сервер (Model Context Protocol) поверх stdio. Клиент
запускает `node src/index.js`, после чего может вызывать инструменты Star Guard.
Сервер не хранит состояние и не вызывает внешние LLM: единственный внешний
сервис — REST API Star Guard по `STAR_GUARD_API_URL`.

```text
MCP-клиент (Claude Code, Claude Desktop, ...)
    │  stdio: JSON-RPC 2.0, одна строка = одно сообщение
    ▼
star-guard-mcp  ──HTTP──►  Star Guard REST API
```

## Подключение

### Claude Code

Проектный `.mcp.json` в корне репозитория (уже есть в этом репозитории):

```json
{
  "mcpServers": {
    "star-guard-mcp": {
      "command": "node",
      "args": ["src/index.js"],
      "env": { "STAR_GUARD_API_URL": "http://localhost:8080" }
    }
  }
}
```

Относительный путь `src/index.js` работает, потому что Claude Code запускает
проектные серверы из корня проекта. Для ручной регистрации используйте
абсолютный путь:

```bash
claude mcp add star-guard-mcp \
  -e STAR_GUARD_API_URL=http://localhost:8080 \
  -- node /absolute/path/to/star-guard-mcp/src/index.js
```

Проверка: команда `/mcp` в Claude Code показывает статус `star-guard-mcp` и
список инструментов.

### Другие stdio-клиенты

Любой клиент с поддержкой stdio-транспорта — та же запись `mcpServers`:
`command` + `args` + опциональный `env`. Абсолютный путь к `src/index.js`
надёжнее относительного. Зависимостей npm нет, `npm install` не требуется.

### Docker

```bash
docker build -t star-guard-mcp .
docker run -i --rm \
  -e STAR_GUARD_API_URL=http://host.docker.internal:8080 \
  star-guard-mcp
```

Флаг `-i` обязателен: без stdin сервер не получит ни одного запроса.
Из контейнера `localhost` указывает на сам контейнер, а не на хост.

## Транспорт

| Свойство | Значение |
|----------|----------|
| Транспорт | stdio |
| Кадрирование | по одному JSON-RPC 2.0 объекту на строку (newline-delimited), без `Content-Length` |
| Кодировка | UTF-8 |
| stdout | только JSON-RPC-сообщения |
| stderr | диагностика, в том числе `star-guard-mcp: API <url>` при старте |
| Пустые строки | игнорируются |
| Невалидный JSON | ответ `-32700 Parse error` с `id: null`, процесс продолжает работу |

Сообщения не должны содержать переводов строк внутри JSON — сервер разбирает
ввод построчно.

## Рукопожатие

1. Клиент отправляет `initialize` с `protocolVersion`.
2. Сервер отвечает `protocolVersion`, `capabilities` и `serverInfo`.
3. Клиент отправляет уведомление `notifications/initialized` (ответа нет).
4. Далее — `tools/list`, `tools/call`, `ping` и т. п.

Версии протокола: `2024-11-05`, `2025-03-26`, `2025-06-18`. Если клиент
запросил поддерживаемую версию — она возвращается как есть; если нет —
сервер отвечает последней поддерживаемой (`2025-06-18`) без ошибки.

Ответ `initialize` также содержит поле `instructions` — краткую инструкцию для
модели: вызывать `assess_dependency` перед использованием библиотеки и
трактовать результат как признаки, а не доказательство.

Пример обмена (по одной строке на сообщение):

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"star-guard-mcp","version":"0.1.0"},"instructions":"..."}}

{"jsonrpc":"2.0","method":"notifications/initialized"}

{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"assess_dependency","description":"...","inputSchema":{}}]}}
```

## Методы

| Метод | Ответ | Назначение |
|-------|-------|------------|
| `initialize` | `result` | согласование версии; отдаёт `capabilities.tools.listChanged = false` |
| `notifications/initialized` | нет | уведомление клиента о завершении рукопожатия |
| `ping` | `result: {}` | проверка живости |
| `tools/list` | `result.tools[]` | статический список инструментов с `inputSchema` |
| `tools/call` | `result` с `content` и `isError` | вызов инструмента |
| `shutdown` | `result: null` | подтверждение остановки; процесс завершается, когда клиент закроет stdin |
| `exit` | нет | уведомление; сервер ничего не отвечает и не завершает цикл сам |

Неизвестный метод с `id` → JSON-RPC-ошибка `-32601`; уведомление (без `id`)
на неизвестный метод ответа не получает.

## Вызов инструментов

Запрос:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"assess_dependency","arguments":{"owner":"demo","name":"farm-target","hours":3}}}
```

Результат:

```json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{ ... JSON-строка ... }"}],"isError":false}}
```

- `content[0].text` — всегда строка; внутри сериализованный JSON-результат
  инструмента (с отступами в 2 пробела).
- `isError: false` — инструмент выполнился, даже если внутри `status` равен
  `scanning`, `no_data` или `error` (это данные, а не сбой вызова).
- `isError: true` — вызов не удался: неизвестный инструмент, невалидные
  аргументы, недоступный Star Guard. Текст начинается с `Ошибка: `.

Аргументы проверяются минимально: `owner`, `name` и `scan_id` — непустые
строки; `repos` в `batch_summaries` — 1–50 строк вида `owner/name`;
`source` (`github|archive`) и `max_level` (`low|medium|high|critical`)
отсекаются обработчиком с понятной ошибкой; `limit`, `hours` и `days`
ограничены схемой. Сервер не выполняет полную валидацию JSON Schema —
некорректные типы отсеиваются обработчиками или самим Star Guard.

Список инструментов и форматы результатов — в [tools.md](tools.md).

## Ошибки

Ошибки уровня протокола возвращаются JSON-RPC-объектом `error`:

| Код | Причина |
|-----|---------|
| `-32700` | строка не является валидным JSON |
| `-32600` | сообщение не объект или отсутствует `method` |
| `-32601` | неизвестный метод |
| `-32603` | необработанное исключение при обработке запроса |

Ошибки уровня инструмента возвращаются как `result.isError = true` и не
останавливают сервер. Сетевой сбой Star Guard превращается в текст
`Ошибка: Star Guard API недоступен (<url>): ...`.

HTTP-статусы Star Guard в `assess_dependency` не выбрасываются как ошибки, а
преобразуются в структурированный результат: `scanning`, `no_data`,
`index_not_ready`, `repo_not_found`, `failed`, `error`. Инструменты
`get_repo_report`, `get_repo_history`, `get_preview`, `start_scan`, `get_scan`,
`list_indexed_repos`, `batch_summaries`, `get_badge` возвращают сырой ответ
Star Guard (`{ status, data }`) как есть. В `batch_summaries` `data` — массив
`RepoSummaryDto` в порядке запроса, а не объект с обёрткой.

## Конфигурация

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `STAR_GUARD_API_URL` | `http://localhost:8080` | адрес Star Guard |
| `STAR_GUARD_SCAN_TIMEOUT_MS` | `60000` | сколько ждать скан репозитория вне индекса |
| `STAR_GUARD_POLL_INTERVAL_MS` | `1500` | интервал опроса статуса скана |
| `STAR_GUARD_REQUEST_TIMEOUT_MS` | `30000` | таймаут одного HTTP-запроса к Star Guard |

Некорректные значения игнорируются и заменяются значениями по умолчанию.
Аргумент `scan_timeout_ms` у `assess_dependency` перекрывает
`STAR_GUARD_SCAN_TIMEOUT_MS` для конкретного вызова.

## Отладка

```bash
# Проверить сам сервер без сети
node --test

# E2E: MCP → Star Guard → трактовка (нужен запущенный Star Guard)
STAR_GUARD_API_URL=http://localhost:8080 node scripts/verify-integration.mjs
```

`verify-integration.mjs` поднимает `src/index.js` по stdio, выполняет
`initialize`, `tools/list`, `assess_dependency`, `batch_summaries` и проверяет
структуру ответа. Owner, name и окно переопределяются через `VERIFY_OWNER`,
`VERIFY_NAME`, `VERIFY_HOURS`, `VERIFY_DAYS`. Дополнительные проверки:
`VERIFY_INDEX=1` — `list_indexed_repos` (допускает 503 в fixture-режиме);
`VERIFY_GITHUB=1` — `get_repo_history` и `get_preview` (нужен `GITHUB_TOKEN`).

Если клиент не видит инструменты, проверьте по порядку:

1. в stderr при старте выводится `star-guard-mcp: API <url>`;
2. `STAR_GUARD_API_URL` доступен из процесса сервера (а из Docker —
   `host.docker.internal`, не `localhost`);
3. в stdout нет посторонних строк — только JSON-RPC (сервер сам ничего другого
   не пишет, но обёртки вроде `docker run` без `-i` могут ломать поток).

## Безопасность и ограничения

- Сервер делает исходящие HTTP-запросы только на `STAR_GUARD_API_URL`; учётные
  данные не используются и не передаются.
- Соединение с Star Guard по умолчанию незашифрованное (`http://`) —
  используйте доверенную внутреннюю сеть или reverse proxy с TLS.
- Один stdio-клиент на процесс; Streamable HTTP-транспорт в PoC не реализован.
- `shutdown` не завершает процесс сам — клиент должен закрыть stdin или
  завершить дочерний процесс.
- `exit` не обрабатывается как команда завершения: сервер игнорирует его и
  продолжает читать stdin.
- MCP доверяет данным Star Guard и явно показывает caveats (`mocked`,
  пропущенные часы архива, ошибки разбора, источник `github_api` без проверок
  по аккаунтам). Трактовка детерминированная, без внешних LLM; это признаки, а
  не доказательство накрутки.

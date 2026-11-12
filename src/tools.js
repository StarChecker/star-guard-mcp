const OWNER_NAME = {
  owner: { type: 'string', minLength: 1, description: 'GitHub owner, например spring-projects' },
  name: { type: 'string', minLength: 1, description: 'GitHub repository name, например spring-boot' },
};

const HOURS = {
  type: 'integer',
  minimum: 1,
  maximum: 24,
  description: 'Окно GH Archive в часах; по умолчанию — настройка сервиса',
};

const DAYS = {
  type: 'integer',
  minimum: 1,
  maximum: 90,
  description: 'Окно истории GitHub в днях; сервис может ограничить его app.github.history.max-days',
};

const SCAN_SOURCE = {
  type: 'string',
  enum: ['github', 'archive'],
  description: 'Источник скана: github — история GitHub (нужен токен), archive — дампы GH Archive; по умолчанию выбирается сервисом',
};

const MAX_LEVEL = {
  type: 'string',
  enum: ['low', 'medium', 'high', 'critical'],
  description: 'Оставить репозитории с уровнем не выше указанного (включает with_score)',
};

export const TOOLS = [
  {
    name: 'assess_dependency',
    description:
      'Проверить GitHub-репозиторий/библиотеку перед использованием. ' +
      'Возвращает score, level и детерминированную трактовку: healthy / borderline / ' +
      'suspicious / critical / insufficient_data, причины и рекомендацию. ' +
      'Для репозитория вне индекса запускает фоновый скан и ждёт результат. ' +
      'Если GitHub-источник недоступен, автоматически повторяет проверку по GH Archive.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['owner', 'name'],
      properties: {
        ...OWNER_NAME,
        hours: HOURS,
        days: DAYS,
        wait_for_scan: {
          type: 'boolean',
          default: true,
          description: 'Ждать завершения скана для репозитория вне индекса',
        },
        scan_timeout_ms: {
          type: 'integer',
          minimum: 1000,
          maximum: 600000,
          description: 'Максимальное ожидание скана, мс',
        },
      },
    },
  },
  {
    name: 'get_repo_report',
    description: 'Вернуть полный отчёт Star Guard по репозиторию: статистика, score, explain, таймлайн.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['owner', 'name'],
      properties: { ...OWNER_NAME, hours: HOURS, days: DAYS },
    },
  },
  {
    name: 'get_repo_history',
    description:
      'Анализ любого публичного репозитория по истории GitHub (нужен GITHUB_TOKEN): ' +
      'дневная история звёзд, форки, issues, PR и коммиты. Проверок по аккаунтам в этом режиме нет.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['owner', 'name'],
      properties: { ...OWNER_NAME, days: DAYS },
    },
  },
  {
    name: 'get_preview',
    description:
      'Базовая статистика GitHub без score: звёзды, форки, issues, watchers, ' +
      'контрибьюторы. Полезно для холодных репозиториев, которых нет в индексе.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['owner', 'name'],
      properties: { ...OWNER_NAME },
    },
  },
  {
    name: 'start_scan',
    description: 'Запустить фоновый скан репозитория вне индекса: GH Archive или историю GitHub.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['owner', 'name'],
      properties: { ...OWNER_NAME, hours: HOURS, source: SCAN_SOURCE },
    },
  },
  {
    name: 'get_scan',
    description: 'Получить статус/результат фонового скана по id.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scan_id'],
      properties: {
        scan_id: { type: 'string', minLength: 1, description: 'id из start_scan' },
      },
    },
  },
  {
    name: 'list_indexed_repos',
    description: 'Список репозиториев, для которых Star Guard отвечает без скана.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 },
        existing_only: {
          type: 'boolean',
          default: true,
          description: 'Пропускать удалённые или скрытые на GitHub репозитории',
        },
        with_score: { type: 'boolean', default: false, description: 'Добавить оценку Star Guard к каждой строке' },
        max_level: MAX_LEVEL,
      },
    },
  },
  {
    name: 'batch_summaries',
    description:
      'Короткие сводки до 50 репозиториев (только индекс). Ответ — массив в порядке запроса; ' +
      'у каждого элемента свой status: ok | not_indexed | no_data | index_not_ready | error.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['repos'],
      properties: {
        repos: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$' },
          description: 'Полные имена owner/name',
        },
        hours: HOURS,
      },
    },
  },
  {
    name: 'get_badge',
    description: 'JSON endpoint-badge для shields.io по репозиторию.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['owner', 'name'],
      properties: { ...OWNER_NAME, hours: HOURS },
    },
  },
];

export function createHandlers(client) {
  return {
    assess_dependency: async (args) => {
      const { owner, name } = requireOwnerName(args);
      return client.assess(owner, name, {
        hours: args.hours,
        days: args.days,
        waitForScan: args.wait_for_scan !== false,
        scanTimeoutMs: args.scan_timeout_ms ?? client.scanTimeoutMs,
      });
    },
    get_repo_report: async (args) => {
      const { owner, name } = requireOwnerName(args);
      return client.getReport(owner, name, args.hours, args.days);
    },
    get_repo_history: async (args) => {
      const { owner, name } = requireOwnerName(args);
      return client.getRepoHistory(owner, name, args.days);
    },
    get_preview: async (args) => {
      const { owner, name } = requireOwnerName(args);
      return client.getPreview(owner, name);
    },
    start_scan: async (args) => {
      const { owner, name } = requireOwnerName(args);
      validateEnum(args.source, ['github', 'archive'], 'source');
      return client.startScan(owner, name, args.hours, args.source);
    },
    get_scan: async (args) => {
      if (typeof args.scan_id !== 'string' || !args.scan_id.trim()) {
        throw new Error('scan_id is required');
      }
      return client.getScan(args.scan_id);
    },
    list_indexed_repos: async (args) => {
      validateEnum(args.max_level, ['low', 'medium', 'high', 'critical'], 'max_level');
      return client.listIndexedRepos({
        limit: args.limit ?? 1000,
        existingOnly: args.existing_only,
        withScore: args.with_score,
        maxLevel: args.max_level,
      });
    },
    batch_summaries: async (args) => {
      if (!Array.isArray(args.repos) || args.repos.length < 1 || args.repos.length > 50) {
        throw new Error('repos must contain between 1 and 50 "owner/name" strings');
      }
      const invalid = args.repos.find((repo) =>
        typeof repo !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo));
      if (invalid) {
        throw new Error(`invalid repository name: ${invalid}`);
      }
      return client.batchSummaries(args.repos, args.hours);
    },
    get_badge: async (args) => {
      const { owner, name } = requireOwnerName(args);
      return client.getBadge(owner, name, args.hours);
    },
  };
}

function requireOwnerName(args) {
  if (typeof args.owner !== 'string' || !args.owner.trim()) {
    throw new Error('owner is required');
  }
  if (typeof args.name !== 'string' || !args.name.trim()) {
    throw new Error('name is required');
  }
  return { owner: args.owner.trim(), name: args.name.trim() };
}

function validateEnum(value, allowed, field) {
  if (value !== undefined && !allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
}

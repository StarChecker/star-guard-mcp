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

export const TOOLS = [
  {
    name: 'assess_dependency',
    description:
      'Проверить GitHub-репозиторий/библиотеку перед использованием. ' +
      'Возвращает score, level и детерминированную трактовку: healthy / borderline / ' +
      'suspicious / critical / insufficient_data, причины и рекомендацию. ' +
      'Для репозитория вне индекса запускает фоновый скан и ждёт результат.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['owner', 'name'],
      properties: {
        ...OWNER_NAME,
        hours: HOURS,
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
      properties: { ...OWNER_NAME, hours: HOURS },
    },
  },
  {
    name: 'start_scan',
    description: 'Запустить фоновый скан GH Archive для репозитория вне индекса.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['owner', 'name'],
      properties: { ...OWNER_NAME, hours: HOURS },
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
      },
    },
  },
  {
    name: 'batch_summaries',
    description: 'Короткие сводки до 50 репозиториев (только индекс).',
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
        waitForScan: args.wait_for_scan !== false,
        scanTimeoutMs: args.scan_timeout_ms ?? client.scanTimeoutMs,
      });
    },
    get_repo_report: async (args) => {
      const { owner, name } = requireOwnerName(args);
      return client.getReport(owner, name, args.hours);
    },
    start_scan: async (args) => {
      const { owner, name } = requireOwnerName(args);
      return client.startScan(owner, name, args.hours);
    },
    get_scan: async (args) => {
      if (typeof args.scan_id !== 'string' || !args.scan_id.trim()) {
        throw new Error('scan_id is required');
      }
      return client.getScan(args.scan_id);
    },
    list_indexed_repos: async (args) => client.listIndexedRepos(args.limit ?? 1000),
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

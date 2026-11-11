import readline from 'node:readline';
import { TOOLS, createHandlers } from './tools.js';

const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const SERVER_INFO = { name: 'star-guard-mcp', version: '0.1.0' };

export class McpServer {
  constructor({ client, serverInfo = SERVER_INFO } = {}) {
    if (!client) {
      throw new Error('StarGuardClient is required');
    }
    this.client = client;
    this.handlers = createHandlers(client);
    this.serverInfo = serverInfo;
  }

  async handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return rpcError(null, -32600, 'Invalid Request');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    if (typeof method !== 'string') {
      return isNotification ? null : rpcError(id, -32600, 'Invalid Request');
    }

    try {
      switch (method) {
        case 'initialize':
          return rpcResult(id, this.initialize(params));
        case 'notifications/initialized':
          return null;
        case 'ping':
          return rpcResult(id, {});
        case 'tools/list':
          return rpcResult(id, { tools: TOOLS });
        case 'tools/call':
          return rpcResult(id, await this.callTool(params));
        case 'shutdown':
          return rpcResult(id, null);
        case 'exit':
          return null;
        default:
          return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      if (isNotification) {
        return null;
      }
      return rpcError(id, -32603, error?.message ?? 'Internal error');
    }
  }

  initialize(params = {}) {
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested)
      ? requested
      : SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1];
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.serverInfo,
      instructions:
        'Star Guard проверяет подозрительность звёзд GitHub-репозитория. ' +
        'Перед использованием open-source библиотеки вызовите assess_dependency. ' +
        'Трактовка детерминированная, без внешних LLM; это признаки, а не доказательство накрутки.',
    };
  }

  async callTool(params = {}) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (typeof name !== 'string' || !name) {
      return toolError('Tool name is required');
    }
    const handler = this.handlers[name];
    if (!handler) {
      return toolError(`Unknown tool: ${name}`);
    }
    try {
      const result = await handler(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: false,
      };
    } catch (error) {
      return toolError(error?.message ?? 'Tool execution failed');
    }
  }
}

export async function runStdio({ client, input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  const server = new McpServer({ client });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  errorOutput.write(`star-guard-mcp: API ${client.baseUrl}\n`);
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      output.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`);
      continue;
    }
    const response = await server.handle(message);
    if (response) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolError(message) {
  return {
    content: [{ type: 'text', text: `Ошибка: ${message}` }],
    isError: true,
  };
}

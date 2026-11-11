#!/usr/bin/env node
import { StarGuardClient } from './client.js';
import { runStdio } from './mcp-server.js';

const client = new StarGuardClient();
await runStdio({ client });

#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPDFCoraServer } from './server.js';

await createPDFCoraServer().connect(new StdioServerTransport());

#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PdfLicense } from '@pdfcora/web';
import { createPDFCoraServer } from './server.js';

// A license key in the environment, as an app would pass it; without one, output is watermarked.
if (process.env.PDFCORA_LICENSE_KEY) await PdfLicense.setKey(process.env.PDFCORA_LICENSE_KEY);
await createPDFCoraServer().connect(new StdioServerTransport());

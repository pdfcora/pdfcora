#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PdfLicense } from '@pdfiumkit/web';
import { createPdfiumKitServer } from './server.js';

// A license key in the environment, as an app would pass it; without one, output is watermarked.
if (process.env.PDFIUMKIT_LICENSE_KEY) await PdfLicense.setKey(process.env.PDFIUMKIT_LICENSE_KEY);
await createPdfiumKitServer().connect(new StdioServerTransport());

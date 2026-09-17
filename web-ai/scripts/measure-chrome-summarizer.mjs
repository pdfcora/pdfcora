#!/usr/bin/env node
/**
 * Measures pdfcora-ai summaries on Chrome's built-in Summarizer (Gemini Nano), in a real Chrome
 * with its own profile under ~/.cache/pdfcora/chrome-ai-profile. The first run downloads the model
 * (about 2.5 minutes on a fast connection); later runs reuse it. Build web and web-ai first.
 *
 * Usage: node web-ai/scripts/measure-chrome-summarizer.mjs [dense]
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './cdp.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = join(process.env.HOME, '.cache/pdfcora/chrome-ai-profile');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.json': 'application/json' };

const server = createServer((request, response) => {
  const path = normalize(join(ROOT, decodeURIComponent(new URL(request.url, 'http://x').pathname)));
  if (!path.startsWith(ROOT) || !existsSync(path) || !statSync(path).isFile()) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(response);
}).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/web-ai/test-browser/summarizer.html`;

const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=9446',
  '--no-first-run', '--no-default-browser-check', url], { stdio: 'ignore' });
try {
  const cdp = await connect(9446);
  for (let i = 0; i < 100 && (await cdp.evaluate(`document.getElementById('result')?.textContent`)) !== 'ready'; i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  // Downloading needs a user gesture, which the evaluation carries.
  const state = await cdp.evaluate(`Summarizer.availability({ type: 'tldr', format: 'plain-text', length: 'medium' })`);
  if (state !== 'available') {
    console.error(`model is ${state}; downloading`);
    await cdp.evaluate(`Summarizer.create({ type: 'tldr', format: 'plain-text', length: 'medium' }).then((s) => s.destroy())`);
  }
  const which = process.argv[2] === 'dense' ? 'window.dense()' : 'window.measure()';
  console.log(JSON.stringify(await cdp.evaluate(which), null, 2));
  cdp.close();
} finally {
  chrome.kill();
  server.close();
}

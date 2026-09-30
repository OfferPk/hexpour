import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';

const repoRoot = process.cwd();
const chromiumPath = process.env.CHROMIUM_BIN || [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
].find((candidate) => existsSync(candidate));

if (!chromiumPath) {
  throw new Error(
    'Chromium was not found. Install a Chromium browser or set CHROMIUM_BIN to its executable path.',
  );
}

const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-viewport-chromium-'));
let server;
let browser;
let socket;
let browserSpawnError;

try {
  server = await createServer({
    configFile: resolve(repoRoot, 'vite.config.ts'),
    root: repoRoot,
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      hmr: false,
    },
  });
  await server.listen();

  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') {
    throw new Error('Vite did not provide a local TCP address for the browser test.');
  }
  const testUrl = `http://127.0.0.1:${address.port}/hexpour/tests/browser/canvas-viewport.html`;

  console.log(`Running 667x375 canvas resize smoke test with ${chromiumPath}`);
  browser = spawn(chromiumPath, [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDirectory}`,
    'about:blank',
  ], { stdio: 'ignore' });
  browser.once('error', (error) => { browserSpawnError = error; });

  const devToolsPortFile = join(profileDirectory, 'DevToolsActivePort');
  let activePortContents;
  const portDeadline = Date.now() + 10_000;
  while (Date.now() < portDeadline) {
    if (browserSpawnError) {
      throw new Error(`Could not start Chromium: ${browserSpawnError.message}`);
    }
    if (browser.exitCode !== null) {
      throw new Error('Chromium exited before its DevTools endpoint was ready.');
    }
    try {
      activePortContents = await readFile(devToolsPortFile, 'utf8');
      break;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  if (!activePortContents) {
    throw new Error('Chromium did not create a DevTools endpoint.');
  }

  const port = Number(activePortContents.trim().split(/\s+/)[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Chromium returned an invalid local DevTools port.');
  }

  let pageTarget;
  const targetDeadline = Date.now() + 10_000;
  while (Date.now() < targetDeadline && !pageTarget) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      pageTarget = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  if (!pageTarget) throw new Error('Could not find Chromium’s local page target.');

  socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('DevTools WebSocket open timed out.')), 5000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolveOpen();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      rejectOpen(new Error('Could not connect to Chromium’s local DevTools WebSocket.'));
    }, { once: true });
  });

  let nextCommandId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message || 'DevTools command failed.'));
    else request.resolve(message.result || {});
  });

  const command = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
    const id = ++nextCommandId;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCommand(new Error(`DevTools command timed out: ${method}`));
    }, 5000);
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });

  await command('Page.enable');
  await command('Runtime.enable');
  await command('Page.navigate', { url: testUrl });

  const testDeadline = Date.now() + 20_000;
  let testResult;
  while (Date.now() < testDeadline) {
    const evaluation = await command('Runtime.evaluate', {
      expression: `(() => {
        const node = document.getElementById('test-result');
        return node ? { status: node.dataset.status, detail: node.textContent } : null;
      })()`,
      returnByValue: true,
    });
    testResult = evaluation.result?.value;
    if (testResult?.status === 'pass' || testResult?.status === 'fail') break;
    if (browser.exitCode !== null) throw new Error('Chromium exited during the browser test.');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  if (!testResult || testResult.status === 'running') {
    throw new Error('The browser fixture did not finish within 20 seconds.');
  }
  if (testResult.status !== 'pass') {
    throw new Error(`Browser regression failed: ${testResult.detail || 'no failure details'}`);
  }

  console.log('PASS: narrow-landscape panel open/close resizes and redraws the canvas.');
  console.log(testResult.detail);
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
} finally {
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveClose) => browser.once('close', resolveClose)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 1500)),
    ]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  }
  if (server) await server.close();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  await rm(profileDirectory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

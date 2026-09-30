import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
if (!chromiumPath) throw new Error('Chromium was not found. Install Chromium or set CHROMIUM_BIN.');

const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-share-cancel-'));
if ((await readdir(profileDirectory)).length !== 0) {
  throw new Error('The disposable Chromium profile must be empty before launch.');
}

let server;
let browser;
let socket;
let commandId = 0;
const pending = new Map();
const checks = [];

function check(ok, label, details) {
  checks.push({ label, ok, details });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`);
}

function command(method, params = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const id = ++commandId;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCommand(new Error(`DevTools command timed out: ${method}`));
    }, 10_000);
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await command('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.result?.exception?.description || response.exceptionDetails.text);
  }
  return response.result?.value;
}

async function waitFor(expression, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function mouseClick(selector) {
  const rect = await evaluate(`(() => {
    const button = ${selector};
    if (!button) return null;
    const r = button.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 && r.height > 0 };
  })()`);
  if (!rect?.visible) throw new Error(`Could not find visible click target: ${selector}`);
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
}

const storageExpression = `(() => {
  const read = (storage) => Object.fromEntries(
    Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key) => key !== null).sort().map((key) => [key, storage.getItem(key)]),
  );
  return { local: read(localStorage), session: read(sessionStorage) };
})()`;

try {
  server = await createServer({
    configFile: resolve(repoRoot, 'vite.config.ts'),
    root: repoRoot,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not provide a loopback address.');
  const targetUrl = `http://127.0.0.1:${address.port}/hexpour/`;

  console.log(`Testing share cancellation in a new disposable Chromium profile: ${targetUrl}`);
  console.log(`Profile directory empty before launch: ${(await readdir(profileDirectory)).length === 0}`);
  browser = spawn(chromiumPath, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore' });

  const portFile = join(profileDirectory, 'DevToolsActivePort');
  let portContents;
  const portDeadline = Date.now() + 10_000;
  while (Date.now() < portDeadline) {
    if (browser.exitCode !== null) throw new Error('Chromium exited before DevTools started.');
    try { portContents = await readFile(portFile, 'utf8'); break; }
    catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  if (!portContents) throw new Error('Chromium did not publish its DevTools endpoint.');
  const devToolsPort = Number(portContents.trim().split(/\s+/)[0]);
  let pageTarget;
  const targetDeadline = Date.now() + 10_000;
  while (Date.now() < targetDeadline && !pageTarget) {
    try {
      pageTarget = (await (await fetch(`http://127.0.0.1:${devToolsPort}/json/list`)).json())
        .find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  if (!pageTarget) throw new Error('No page target in the disposable Chromium profile.');

  socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message || 'CDP command failed.'));
    else request.resolve(message.result || {});
  });
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('DevTools socket open timed out.')), 5_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('Could not connect to disposable Chromium.')); }, { once: true });
  });

  await command('Page.enable');
  await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 844, height: 720, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: targetUrl });
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#home.screen.active')`, 'Home screen');
  const emptyStorage = await evaluate(storageExpression);
  check(Object.keys(emptyStorage.local).length === 0 && Object.keys(emptyStorage.session).length === 0,
    'Temporary origin storage is empty before any test data or interaction', emptyStorage);

  await evaluate(`document.querySelector('.overlay.open button')?.click()`);
  await waitFor(`!document.querySelector('.overlay.open')`, 'How-to dismissal');
  await evaluate(`document.querySelector('#home .home-actions button')?.click()`);
  await waitFor(`!!document.querySelector('#play.screen.active')`, 'Level 1');
  const opening = await evaluate(`({
    level: document.querySelector('#play .title')?.textContent,
    source: document.querySelectorAll('.cell-control')[0]?.getAttribute('aria-label'),
    target: document.querySelectorAll('.cell-control')[2]?.getAttribute('aria-label'),
  })`);
  check(opening.level === 'Level 1' && opening.source?.includes('green, green, red') && opening.target?.includes('red, red'),
    'Fresh Level 1 exposes the intended adjacent one-pour solve', opening);
  await evaluate(`document.querySelectorAll('.cell-control')[0]?.click()`);
  await evaluate(`document.querySelectorAll('.cell-control')[2]?.click()`);
  await waitFor(`!!document.querySelector('#win.screen.active')`, 'Level 1 completion');
  const win = await evaluate(`({
    heading: document.querySelector('#win h1')?.textContent?.trim(),
    summary: document.querySelector('#win .tagline')?.textContent?.trim(),
  })`);
  check(win.heading === 'Hive clear!' && win.summary?.includes('Level 1 complete in 1 pour'),
    'The disposable run reaches its expected one-pour win screen', win);

  await evaluate(`(() => {
    window.__shareCalls = [];
    window.__clipboardCalls = [];
    window.__shareMode = 'abort';
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (payload) => {
        window.__shareCalls.push(payload);
        if (window.__shareMode === 'abort') throw new DOMException('User cancelled the share sheet', 'AbortError');
        throw new Error('Share is unavailable');
      },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__clipboardCalls.push(text); } },
    });
  })()`);

  const beforeShare = await evaluate(storageExpression);
  await mouseClick(`([...document.querySelectorAll('#win .home-actions button')].find((button) => button.textContent.trim() === 'Share'))`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  const afterCancel = await evaluate(`({
    shareCalls: window.__shareCalls,
    clipboardCalls: window.__clipboardCalls,
    toast: { text: document.querySelector('.toast')?.textContent, hidden: document.querySelector('.toast')?.hidden },
    screen: [...document.querySelectorAll('.screen.active')].map((node) => node.id),
    focus: document.activeElement?.textContent?.trim(),
    storage: ${storageExpression},
  })`);
  check(afterCancel.shareCalls.length === 1 && afterCancel.shareCalls[0]?.title === 'HexPour' &&
    afterCancel.shareCalls[0]?.text?.includes('Level 1'),
  'Native Share receives the correct Level 1 summary once', afterCancel.shareCalls);
  check(afterCancel.clipboardCalls.length === 0,
    'Cancelling native Share does not write a clipboard fallback', afterCancel.clipboardCalls);
  check(afterCancel.toast.hidden === true && afterCancel.toast.text === '' &&
    afterCancel.screen.join(',') === 'win' && afterCancel.focus === 'Share',
  'Share cancellation leaves the win screen and focus undisturbed without a false success toast', afterCancel);
  check(JSON.stringify(afterCancel.storage) === JSON.stringify(beforeShare),
    'Share cancellation preserves the exact saved settings, unlocks, and completion state', { beforeShare, afterCancel: afterCancel.storage });

  await evaluate(`window.__shareMode = 'error'`);
  await mouseClick(`([...document.querySelectorAll('#win .home-actions button')].find((button) => button.textContent.trim() === 'Share'))`);
  await waitFor(`document.querySelector('.toast')?.textContent === 'Copied'`, 'clipboard fallback confirmation');
  const afterFallback = await evaluate(`({
    shareCalls: window.__shareCalls,
    clipboardCalls: window.__clipboardCalls,
    toast: { text: document.querySelector('.toast')?.textContent, hidden: document.querySelector('.toast')?.hidden },
    storage: ${storageExpression},
  })`);
  check(afterFallback.shareCalls.length === 2 &&
    afterFallback.clipboardCalls.length === afterCancel.clipboardCalls.length + 1 &&
    afterFallback.clipboardCalls.at(-1) === afterCancel.shareCalls[0].text &&
    afterFallback.toast.text === 'Copied' && afterFallback.toast.hidden === false,
  'Non-cancellation Share errors retain the existing clipboard fallback', afterFallback);
  check(JSON.stringify(afterFallback.storage) === JSON.stringify(beforeShare),
    'Clipboard fallback also preserves saved settings, unlocks, and completion state', { beforeShare, afterFallback: afterFallback.storage });

  const report = {
    status: checks.every(({ ok }) => ok) ? 'PASS' : 'FAIL',
    target: targetUrl,
    profile: 'new empty disposable Chromium profile; origin local/session storage verified empty before interaction; profile removed after test',
    spokenReader: 'not tested',
    checks,
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
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
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  await rm(profileDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

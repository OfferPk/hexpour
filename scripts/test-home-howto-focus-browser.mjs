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

const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-home-howto-focus-'));
if ((await readdir(profileDirectory)).length !== 0) {
  throw new Error('The disposable Chromium profile must be empty before launch.');
}
let server;
let browser;
let socket;
let nextCommandId = 0;
const pending = new Map();
const checks = [];
function check(ok, label, details) {
  checks.push({ label, ok, details });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`);
}
function command(method, params = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const id = ++nextCommandId;
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
async function pressKey(key) {
  const virtualKey = ({ Tab: 9, Enter: 13 })[key];
  if (!virtualKey) throw new Error(`Unsupported test key: ${key}`);
  const params = { key, code: key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey };
  await command('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
  if (key === 'Enter') {
    await command('Input.dispatchKeyEvent', { type: 'char', ...params, text: '\r', unmodifiedText: '\r' });
  }
  await command('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}
const storageExpression = `(() => {
  const read = (storage) => Object.fromEntries(
    Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key) => key !== null).sort().map((key) => [key, storage.getItem(key)]),
  );
  return { local: read(localStorage), session: read(sessionStorage) };
})()`;
try {
  let targetUrl;
  if (process.env.HEXPOUR_TEST_URL) {
    const publicUrl = new URL(process.env.HEXPOUR_TEST_URL);
    if (!['http:', 'https:'].includes(publicUrl.protocol)) throw new Error('HEXPOUR_TEST_URL must use HTTP or HTTPS.');
    targetUrl = publicUrl.href;
  } else {
    server = await createServer({
      configFile: resolve(repoRoot, 'vite.config.ts'),
      root: repoRoot,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not provide a loopback address.');
    targetUrl = `http://127.0.0.1:${address.port}/hexpour/`;
  }
  console.log(`Testing Home How-to focus in a new disposable Chromium profile: ${targetUrl}`);
  console.log(`Profile directory empty before Chromium launch: ${(await readdir(profileDirectory)).length === 0}`);
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
    } catch {}
    if (!pageTarget) await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
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
    if (message.error) request.reject(new Error(message.error.message || 'DevTools command failed.'));
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
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#app')`, 'the app shell');

  const emptyStorage = await evaluate(storageExpression);
  check(Object.keys(emptyStorage.local).length === 0 && Object.keys(emptyStorage.session).length === 0,
    'Origin localStorage and sessionStorage are empty before test seeding', emptyStorage);
  if (Object.keys(emptyStorage.local).length || Object.keys(emptyStorage.session).length) {
    throw new Error('Refusing to seed a non-empty browser origin.');
  }

  const settings = JSON.stringify({ unlocked: 3, adsRemoved: true, mute: true });
  const completed = JSON.stringify([1]);
  const savedRun = JSON.stringify({
    version: 1,
    levelId: 2,
    savedAt: Date.now(),
    moveCount: 1,
    freeHintUsed: false,
    board: { capacity: 3, cells: [
      { q: 0, r: 0, blocked: false, stack: ['R'] },
      { q: 1, r: 0, blocked: false, stack: ['G', 'R'] },
      { q: 0, r: 1, blocked: false, stack: ['G', 'G'] },
    ] },
    undoStack: [{ capacity: 3, cells: [
      { q: 0, r: 0, blocked: false, stack: ['R', 'G', 'G'] },
      { q: 1, r: 0, blocked: false, stack: ['G', 'R'] },
      { q: 0, r: 1, blocked: false, stack: [] },
    ] }],
  });
  await evaluate(`(() => {
    localStorage.setItem('hexpour_v1', ${JSON.stringify(settings)});
    localStorage.setItem('hexpour:completed-levels', ${JSON.stringify(completed)});
    localStorage.setItem('hexpour:in-progress', ${JSON.stringify(savedRun)});
    localStorage.setItem('hexpour:howto', '1');
    sessionStorage.setItem('hexpour:a2hs', '1');
  })()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`!!document.querySelector('#home.screen.active button.home-resume')`, 'Home with the valid saved Level 2 run');
  const before = await evaluate(`({
    screen: [...document.querySelectorAll('.screen.active')].map((node) => node.id),
    resume: document.querySelector('#home .home-resume')?.getAttribute('aria-label'),
    storage: ${storageExpression},
  })`);
  if (before.screen.join(',') !== 'home' || before.resume !== 'Resume Level 2 · 1 pour' ||
      before.storage.local['hexpour_v1'] !== settings ||
      before.storage.local['hexpour:in-progress'] !== savedRun) {
    throw new Error(`The isolated valid saved-run fixture was not restored intact: ${JSON.stringify(before)}`);
  }
  check(true, 'Valid Level 2 saved run and one-entry Undo history are present before the interaction', before.resume);

  await evaluate(`document.querySelector('#home .home-actions button')?.focus()`);
  const focusRoute = [];
  for (let index = 0; index < 3; index++) {
    await pressKey('Tab');
    focusRoute.push(await evaluate(`({text: document.activeElement?.textContent?.trim(), label: document.activeElement?.getAttribute('aria-label')})`));
  }
  check(focusRoute.at(-1)?.text === 'How to play', 'Keyboard traversal reaches Home How to play from a saved-run Home screen', focusRoute);
  if (focusRoute.at(-1)?.text !== 'How to play') throw new Error('Keyboard did not reach Home How to play.');
  await pressKey('Enter');
  await waitFor(`!!document.querySelector('.overlay.open [role="dialog"]')`, 'the Home How-to dialog');
  const dialog = await evaluate(`(() => {
    const node = document.querySelector('.overlay.open [role="dialog"]');
    return { name: document.getElementById(node?.getAttribute('aria-labelledby'))?.textContent, modal: node?.getAttribute('aria-modal'), focus: document.activeElement?.textContent?.trim() };
  })()`);
  check(dialog.name === 'How to play' && dialog.modal === 'true' && dialog.focus === 'Got it',
    'Home How-to opens as a named modal and focuses Got it', dialog);
  await pressKey('Enter');
  await waitFor(`!document.querySelector('.overlay.open') && !!document.querySelector('#home.screen.active')`, 'How-to dismissal back to Home');

  const after = await evaluate(`(() => {
    const focus = document.activeElement;
    const howto = [...document.querySelectorAll('#home .home-actions button')].find((button) => button.textContent.trim() === 'How to play');
    return {
      screen: [...document.querySelectorAll('.screen.active')].map((node) => node.id),
      focusedHowto: focus === howto,
      focusText: focus?.textContent?.trim(),
      focusVisible: focus?.matches(':focus-visible'),
      outlineStyle: focus ? getComputedStyle(focus).outlineStyle : null,
      resume: document.querySelector('#home .home-resume')?.getAttribute('aria-label'),
      storage: ${storageExpression},
    };
  })()`);
  check(after.screen.join(',') === 'home' && after.focusedHowto && after.focusText === 'How to play' &&
      after.focusVisible && after.outlineStyle === 'solid',
    'Dismissal restores visible keyboard focus to the Home How-to opener', after);
  check(JSON.stringify(after.storage) === JSON.stringify(before.storage),
    'How-to dismissal preserves the exact saved run, Undo snapshot, settings/unlocks, completion data, and session state',
    { before: before.storage, after: after.storage });
  check(after.resume === before.resume, 'The same saved Level 2 resume action remains available', after.resume);

  const report = {
    status: checks.every(({ ok }) => ok) ? 'PASS' : 'FAIL',
    target: targetUrl,
    profile: 'new empty disposable Chromium profile; profile and origin storage verified empty before seeding; removed after test',
    spokenScreenReader: 'not tested',
    checks,
  };
  console.log(JSON.stringify(report, null, 2));
  if (checks.some(({ ok }) => !ok)) process.exitCode = 1;
} finally {
  try { socket?.close(); } catch {}
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveClose) => browser.once('close', resolveClose)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500)),
    ]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  }
  if (server) await server.close();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  await rm(profileDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

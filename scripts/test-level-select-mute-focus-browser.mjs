import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';

const repoRoot = process.cwd();
const requestedUrl = process.env.HEXPOUR_TEST_URL;
const chromiumPath = process.env.CHROMIUM_BIN || [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
].find((candidate) => existsSync(candidate));
if (!chromiumPath) throw new Error('Chromium was not found. Install Chromium or set CHROMIUM_BIN.');

const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-level-select-mute-focus-'));
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

async function waitFor(expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  const diagnostic = await evaluate('({url:location.href,title:document.title,body:document.body?.innerText?.slice(0,240)})');
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}

async function pressKey(key) {
  const virtualKey = ({ Tab: 9, Enter: 13 })[key];
  if (!virtualKey) throw new Error(`Unsupported test key: ${key}`);
  const params = { key, code: key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey };
  await command('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
  if (key === 'Enter') {
    await command('Input.dispatchKeyEvent', {
      type: 'char', ...params, text: '\r', unmodifiedText: '\r',
    });
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
const focusExpression = `(() => {
  const node = document.activeElement;
  if (!node) return null;
  return {
    tag: node.tagName,
    text: (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100),
    label: node.getAttribute('aria-label'),
    className: typeof node.className === 'string' ? node.className : '',
    focusVisible: node.matches(':focus-visible'),
  };
})()`;

try {
  let targetUrl;
  let expectedAssets = [];
  if (requestedUrl) {
    const liveUrl = new URL(requestedUrl);
    liveUrl.searchParams.set('hexpour_review', String(Date.now()));
    targetUrl = liveUrl.toString();
    expectedAssets = (await readdir(resolve(repoRoot, 'dist/assets'))).filter((name) =>
      /^index-[A-Za-z0-9_-]+\.(?:js|css)$/.test(name),
    );
    if (!['js', 'css'].every((extension) => expectedAssets.some((name) => name.endsWith(`.${extension}`)))) {
      throw new Error('The live regression needs current built hashed JavaScript and CSS in dist/assets.');
    }
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

  console.log(`Testing Level Select Mute keyboard focus in a new disposable Chromium profile: ${targetUrl}`);
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
    if (browser.exitCode !== null) throw new Error('Chromium exited before its DevTools endpoint was ready.');
    try { portContents = await readFile(portFile, 'utf8'); break; }
    catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  if (!portContents) throw new Error('Chromium did not create a DevTools endpoint.');
  const devToolsPort = Number(portContents.trim().split(/\s+/)[0]);
  let pageTarget;
  const targetDeadline = Date.now() + 10_000;
  while (Date.now() < targetDeadline && !pageTarget) {
    try {
      const response = await fetch(`http://127.0.0.1:${devToolsPort}/json/list`);
      pageTarget = (await response.json()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  if (!pageTarget) throw new Error('Could not find the disposable Chromium page target.');

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
    const timer = setTimeout(() => rejectOpen(new Error('DevTools socket open timed out.')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('Could not connect to DevTools.')); }, { once: true });
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', {
    width: 844, height: 720, deviceScaleFactor: 1, mobile: false,
  });
  await command('Page.navigate', { url: targetUrl });
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#home.screen.active')`, 'Home screen');

  if (requestedUrl) {
    const loadedAssets = await evaluate(`performance.getEntriesByType('resource').map(({name})=>new URL(name).pathname.split('/').pop()).filter(Boolean)`);
    check(expectedAssets.every((name) => loadedAssets.includes(name)),
      'Live page loaded the current build’s hashed JavaScript and CSS', { expected: expectedAssets, loaded: loadedAssets });
  }

  const emptyStorage = await evaluate(storageExpression);
  check(Object.keys(emptyStorage.local).length === 0 && Object.keys(emptyStorage.session).length === 0,
    'Fresh local and session storage are empty before synthetic setup', emptyStorage);
  if (Object.keys(emptyStorage.local).length || Object.keys(emptyStorage.session).length) {
    throw new Error('The disposable browser profile unexpectedly contained site storage before fixture setup.');
  }

  const originalSettings = JSON.stringify({ unlocked: 3, adsRemoved: true, mute: false });
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
      { q: 0, r: 1, blocked: false, stack: [],
    }] }],
  });
  await evaluate(`(() => {
    localStorage.setItem('hexpour_v1', ${JSON.stringify(originalSettings)});
    localStorage.setItem('hexpour:in-progress', ${JSON.stringify(savedRun)});
    localStorage.setItem('hexpour:howto', '1');
    sessionStorage.setItem('hexpour:a2hs', '1');
    return true;
  })()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`!!document.querySelector('#home.screen.active .home-resume')`, 'Home with the isolated saved-run fixture');
  const fixture = await evaluate(`({storage:${storageExpression},resume:document.querySelector('#home .home-resume')?.textContent.trim()})`);
  check(fixture.storage.local.hexpour_v1 === originalSettings &&
    fixture.storage.local['hexpour:in-progress'] === savedRun &&
    fixture.resume?.startsWith('Resume Level 2') &&
    JSON.parse(fixture.storage.local['hexpour:in-progress']).undoStack.length === 1,
  'Test-owned settings, unlocks, and one-entry Undo snapshot load intact', fixture);
  if (fixture.storage.local.hexpour_v1 !== originalSettings ||
      fixture.storage.local['hexpour:in-progress'] !== savedRun ||
      !fixture.resume?.startsWith('Resume Level 2')) {
    throw new Error('The isolated settings/save fixture did not load intact.');
  }

  await evaluate(`document.querySelector('#home .level-select-opener')?.focus()`);
  const homeFocus = await evaluate(focusExpression);
  check(homeFocus?.text === 'Levels', 'Keyboard starts from the Home Level Select opener', homeFocus);
  await pressKey('Enter');
  await waitFor(`!!document.querySelector('#levels.screen.active .level-btn')`, 'Level Select');
  await pressKey('Tab');
  const backFocus = await evaluate(focusExpression);
  await pressKey('Tab');
  const muteFocus = await evaluate(focusExpression);
  check(backFocus?.label === 'Back to home' && muteFocus?.label === 'Mute',
    'Keyboard traversal reaches the Level Select Mute control in order', { backFocus, muteFocus });
  await pressKey('Enter');
  await waitFor(`!!document.querySelector('#levels.screen.active button[aria-label="Unmute"]')`, 'Mute toggle to rerender as Unmute');
  const after = await evaluate(`({
    screen:[...document.querySelectorAll('.screen.active')].map(node=>node.id),
    focus:${focusExpression},
    storage:${storageExpression},
    levelCount:document.querySelectorAll('#levels .level-btn').length,
    unlockedCount:document.querySelectorAll('#levels .level-btn:not(:disabled)').length,
    savedProgress:document.querySelector('#levels .level-btn.in-progress')?.getAttribute('aria-label'),
  })`);
  const expectedSettings = JSON.stringify({ unlocked: 3, adsRemoved: true, mute: true });
  const statePreserved = after.screen.join(',') === 'levels' &&
    after.storage.local.hexpour_v1 === expectedSettings &&
    after.storage.local['hexpour:in-progress'] === savedRun &&
    after.storage.local['hexpour:howto'] === '1' &&
    JSON.stringify(after.storage.session) === JSON.stringify(fixture.storage.session) &&
    Object.keys(after.storage.local).length === 3 &&
    after.levelCount === 40 && after.unlockedCount === 3 &&
    after.savedProgress === 'Level 2, complete, in progress, resume with 1 pour' &&
    JSON.parse(after.storage.local['hexpour:in-progress']).undoStack.length === 1;
  check(statePreserved,
    'Mute updates only its setting while preserving unlocks, save, Undo history, and surrounding storage', after);
  check(after.focus?.label === 'Unmute' && after.focus?.focusVisible,
    'Keyboard focus is restored to the equivalent Level Select toggle after rerender', after.focus);

  const failed = checks.filter(({ ok }) => !ok);
  console.log(JSON.stringify({
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    target: targetUrl,
    profile: 'fresh empty disposable Chromium profile; storage checked before fixture setup; removed after test',
    checks,
    spokenReader: 'not tested',
  }, null, 2));
  if (failed.length) process.exitCode = 1;
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
} finally {
  try { socket?.close(); } catch {}
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
  await rm(profileDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

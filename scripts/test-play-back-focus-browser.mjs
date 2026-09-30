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

const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-play-back-focus-'));
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
  checks.push({ label, ok: Boolean(ok), details });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`);
  return Boolean(ok);
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
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
  }
  const diagnostic = await evaluate('({url:location.href,title:document.title,body:document.body?.innerText?.slice(0,240)})');
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}

async function pressEnter() {
  const params = {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
  await command('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
  await command('Input.dispatchKeyEvent', {
    type: 'char', ...params, text: '\r', unmodifiedText: '\r',
  });
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
    disabled: node instanceof HTMLButtonElement ? node.disabled : false,
    inLevelSelect: node.closest('#levels') !== null,
    focusVisible: node.matches(':focus-visible'),
  };
})()`;

try {
  let targetUrl;
  let expectedAssets = [];
  if (requestedUrl) {
    const liveUrl = new URL(requestedUrl);
    liveUrl.searchParams.set('hexpour_back_focus_review', String(Date.now()));
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

  console.log(`Testing keyboard Back to levels focus in a new disposable Chromium profile: ${targetUrl}`);
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
  await new Promise((resolveSocket, rejectSocket) => {
    socket.addEventListener('open', resolveSocket, { once: true });
    socket.addEventListener('error', rejectSocket, { once: true });
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result || {});
  });

  await command('Page.navigate', { url: targetUrl });
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#home.screen.active')`, 'Home screen');
  if (requestedUrl) {
    const loadedAssets = await evaluate(`performance.getEntriesByType('resource').map(({name})=>new URL(name).pathname.split('/').pop()).filter(Boolean)`);
    check(expectedAssets.every((name) => loadedAssets.includes(name)),
      'The live page loaded the current build’s hashed JavaScript and CSS', { expected: expectedAssets, loaded: loadedAssets });
  }

  const emptyStorage = await evaluate(storageExpression);
  const storageWasEmpty = Object.keys(emptyStorage.local).length === 0 && Object.keys(emptyStorage.session).length === 0;
  check(storageWasEmpty, 'Fresh local and session storage are empty before synthetic setup', emptyStorage);
  if (!storageWasEmpty) throw new Error('The disposable origin unexpectedly contained storage before fixture setup.');

  const originalSettings = JSON.stringify({ unlocked: 2, adsRemoved: true, mute: false });
  const completedLevels = '[1]';
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
    localStorage.setItem('hexpour:completed-levels', ${JSON.stringify(completedLevels)});
    localStorage.setItem('hexpour:howto', '1');
    sessionStorage.setItem('hexpour:a2hs', '1');
    return true;
  })()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`!!document.querySelector('#home.screen.active .home-actions button')`, 'Home after isolated settings setup');
  await evaluate(`document.querySelector('#home .home-actions > button')?.click()`);
  await waitFor(`document.querySelector('#play.screen.active .move-status')?.textContent === 'Pours: 0'`, 'fresh Level 2');

  const before = await evaluate(`({
    screen: document.querySelector('.screen.active')?.id,
    level: document.querySelector('#play .topbar .title')?.textContent.trim(),
    moveStatus: document.querySelector('#play .move-status')?.textContent,
    undoDisabled: [...document.querySelectorAll('#play .toolbar button')].find((button) => button.textContent.trim() === 'Undo')?.disabled,
    settings: localStorage.getItem('hexpour_v1'),
    completed: localStorage.getItem('hexpour:completed-levels'),
    progress: localStorage.getItem('hexpour:in-progress'),
  })`);
  const startedFreshLevel = before.screen === 'play' && before.level === 'Level 2' &&
    before.moveStatus === 'Pours: 0' && before.undoDisabled === true && before.progress === null &&
    before.settings === originalSettings && before.completed === completedLevels;
  check(startedFreshLevel, 'Play starts Level 2 with no prior run and Undo disabled before any move', before);
  if (!startedFreshLevel) throw new Error('The disposable browser did not start a fresh Level 2.');

  // Add a valid, test-owned saved-run fixture only after the active board has loaded.
  await evaluate(`localStorage.setItem('hexpour:in-progress', ${JSON.stringify(savedRun)})`);
  const fixtureCheck = await evaluate(`({
    settings: localStorage.getItem('hexpour_v1'),
    completed: localStorage.getItem('hexpour:completed-levels'),
    progress: localStorage.getItem('hexpour:in-progress'),
    moveCount: JSON.parse(localStorage.getItem('hexpour:in-progress') || 'null')?.moveCount,
    undoDepth: JSON.parse(localStorage.getItem('hexpour:in-progress') || 'null')?.undoStack?.length,
  })`);
  const fixtureReady = fixtureCheck.settings === originalSettings && fixtureCheck.completed === completedLevels &&
    fixtureCheck.progress === savedRun && fixtureCheck.moveCount === 1 && fixtureCheck.undoDepth === 1;
  check(fixtureReady, 'A test-owned one-move save and Undo snapshot are staged without performing a pour', fixtureCheck);
  if (!fixtureReady) throw new Error('The test-owned run fixture did not stage intact.');

  await evaluate(`document.querySelector('#play button[aria-label="Back to levels"]')?.focus()`);
  await pressEnter();
  await waitFor(`!!document.querySelector('#levels.screen.active .level-btn')`, 'Level Select after keyboard Back to levels');

  const after = await evaluate(`({
    screen: [...document.querySelectorAll('.screen.active')].map((node) => node.id),
    focus: ${focusExpression},
    focusedLevelButton: document.activeElement === document.querySelectorAll('#levels .level-btn')[1],
    levelCount: document.querySelectorAll('#levels .level-btn').length,
    unlockedCount: document.querySelectorAll('#levels .level-btn:not(:disabled)').length,
    progressLabel: document.querySelector('#levels .level-btn.in-progress')?.getAttribute('aria-label'),
    moveStatus: document.querySelector('#play .move-status')?.textContent,
    undoDisabled: [...document.querySelectorAll('#play .toolbar button')].find((button) => button.textContent.trim() === 'Undo')?.disabled,
    storage: ${storageExpression},
  })`);
  const focusReturned = after.screen.join(',') === 'levels' && after.focusedLevelButton &&
    after.focus?.tag === 'BUTTON' && after.focus?.inLevelSelect && after.focus?.label?.startsWith('Level 2') &&
    after.focus?.focusVisible && !after.focus?.disabled;
  check(focusReturned, 'Keyboard Back to levels returns focus to the Level 2 button', {
    screen: after.screen, focus: after.focus, focusedLevelButton: after.focusedLevelButton,
  });

  const statePreserved = after.storage.local.hexpour_v1 === originalSettings &&
    after.storage.local['hexpour:completed-levels'] === completedLevels &&
    after.storage.local['hexpour:in-progress'] === savedRun &&
    after.storage.local['hexpour:howto'] === '1' &&
    after.storage.session['hexpour:a2hs'] === '1' &&
    Object.keys(after.storage.local).length === 4 && Object.keys(after.storage.session).length === 1 &&
    after.levelCount === 40 && after.unlockedCount === 2 &&
    after.progressLabel === 'Level 2, in progress, resume with 1 pour' &&
    after.moveStatus === before.moveStatus && after.undoDisabled === before.undoDisabled;
  check(statePreserved, 'Back navigation preserves the saved run/Undo snapshot, settings, unlocks, and no-pour state', {
    levelCount: after.levelCount, unlockedCount: after.unlockedCount,
    progressLabel: after.progressLabel, moveStatus: after.moveStatus,
    undoDisabled: after.undoDisabled, storage: after.storage,
  });

  const failed = checks.filter(({ ok }) => !ok);
  console.log(JSON.stringify({
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    target: targetUrl,
    interaction: 'keyboard activation of Play → Back to levels; no pour input was sent',
    profile: 'new empty disposable Chromium profile; origin storage checked before fixture; removed after test',
    emptyStorage,
    before: { screen: before.screen, level: before.level, moveStatus: before.moveStatus, undoDisabled: before.undoDisabled },
    after: {
      screen: after.screen, focus: after.focus, focusedLevelButton: after.focusedLevelButton,
      progressLabel: after.progressLabel, levelCount: after.levelCount, unlockedCount: after.unlockedCount,
      moveStatus: after.moveStatus, undoDisabled: after.undoDisabled,
      settings: after.storage.local.hexpour_v1, completed: after.storage.local['hexpour:completed-levels'],
      savedRunMoveCount: JSON.parse(after.storage.local['hexpour:in-progress'] || 'null')?.moveCount,
      undoDepth: JSON.parse(after.storage.local['hexpour:in-progress'] || 'null')?.undoStack?.length,
    },
    checks,
    spokenScreenReaderOutput: 'not tested; browser focus target and DOM state were observed',
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

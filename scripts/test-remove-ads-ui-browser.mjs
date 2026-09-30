import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';

const repoRoot = process.cwd();
const requestedUrl = process.env.HEXPOUR_TEST_URL;
if (requestedUrl) {
  const parsed = new URL(requestedUrl);
  if (parsed.origin !== 'https://offerpk.github.io' || parsed.pathname !== '/hexpour/') {
    throw new Error('HEXPOUR_TEST_URL is restricted to the canonical Hexpour Pages URL.');
  }
}
const chromiumPath = process.env.CHROMIUM_BIN || [
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome',
].find((candidate) => existsSync(candidate));
if (!chromiumPath) throw new Error('Chromium not found.');
const profile = await mkdtemp(join(tmpdir(), 'hexpour-remove-ads-ui-'));
let server;
let browser;
let socket;
let nextId = 0;
const pending = new Map();

function command(method, params = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCommand(new Error(`Timed out: ${method}`));
    }, 8000);
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

async function waitFor(expression, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function pressKey(key, shift = false) {
  const virtualKey = ({ Tab: 9, Enter: 13 })[key];
  if (virtualKey === undefined) throw new Error(`Unsupported test key: ${key}`);
  const params = {
    key,
    code: key,
    windowsVirtualKeyCode: virtualKey,
    nativeVirtualKeyCode: virtualKey,
    modifiers: shift ? 8 : 0,
  };
  await command('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
  if (key === 'Enter') {
    await command('Input.dispatchKeyEvent', {
      type: 'char', ...params, text: '\r', unmodifiedText: '\r',
    });
  }
  await command('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

function stableStorageExpression() {
  return `(()=>({
    settings:localStorage.getItem('hexpour_v1'),
    progress:localStorage.getItem('hexpour:in-progress'),
    completion:localStorage.getItem('hexpour:completed-levels'),
    howto:localStorage.getItem('hexpour:howto'),
    session:Object.fromEntries(Object.keys(sessionStorage).sort().map(k=>[k,sessionStorage.getItem(k)]))
  }))()`;
}

try {
  if ((await readdir(profile)).length !== 0) {
    throw new Error('Disposable Chromium profile must be empty before launch.');
  }
  let url = requestedUrl;
  if (!url) {
    server = await createServer({
      configFile: resolve(repoRoot, 'vite.config.ts'),
      root: repoRoot,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not provide a loopback address.');
    url = `http://127.0.0.1:${address.port}/hexpour/`;
  }

  browser = spawn(chromiumPath, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  let contents;
  const portDeadline = Date.now() + 10000;
  while (Date.now() < portDeadline && !contents) {
    if (browser.exitCode !== null) throw new Error('Chromium exited before DevTools started.');
    try { contents = await readFile(portFile, 'utf8'); }
    catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  if (!contents) throw new Error('Chromium did not publish its DevTools port.');
  const port = Number(contents.trim().split(/\s+/)[0]);
  let target;
  const targetDeadline = Date.now() + 10000;
  while (Date.now() < targetDeadline && !target) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  if (!target) throw new Error('No fresh Chromium page target.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
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
    const timer = setTimeout(() => rejectOpen(new Error('DevTools WebSocket open timeout.')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('DevTools WebSocket error.')); }, { once: true });
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Accessibility.enable');
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
  });
  await command('Page.navigate', { url });
  await waitFor(`document.readyState==='complete' && !!document.querySelector('#home.screen.active')`, 'fresh Home');

  const initialStorage = await evaluate(`(()=>({
    local:Object.fromEntries(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)])),
    session:Object.fromEntries(Object.keys(sessionStorage).sort().map(k=>[k,sessionStorage.getItem(k)]))
  }))()`);
  if (Object.keys(initialStorage.local).length || Object.keys(initialStorage.session).length) {
    throw new Error(`Origin storage was not empty before synthetic setup: ${JSON.stringify(initialStorage)}`);
  }
  if (!await evaluate(`!!document.querySelector('.overlay.open [role="dialog"]')`)) {
    throw new Error('Fresh profile did not show first-run How to play.');
  }
  await evaluate(`document.querySelector('.overlay.open button')?.click()`);
  await waitFor(`!document.querySelector('.overlay.open')`, 'first-run How-to dismissal');

  const settings = JSON.stringify({ unlocked: 3, adsRemoved: false, mute: true });
  const progress = JSON.stringify({
    version: 1,
    levelId: 2,
    savedAt: Date.now(),
    moveCount: 1,
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
  const completion = JSON.stringify([1]);
  await evaluate(`(()=>{
    localStorage.setItem('hexpour_v1',${JSON.stringify(settings)});
    localStorage.setItem('hexpour:in-progress',${JSON.stringify(progress)});
    localStorage.setItem('hexpour:completed-levels',${JSON.stringify(completion)});
    localStorage.setItem('hexpour:howto','1');
    sessionStorage.setItem('hexpour:a2hs','1');
  })()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`!!document.querySelector('#home.screen.active .home-resume')`, 'Home with synthetic Level 2 saved run');
  const before = await evaluate(stableStorageExpression());
  if (before.settings !== settings || before.progress !== progress || before.completion !== completion) {
    throw new Error(`Synthetic saved run or preferences did not load unchanged: ${JSON.stringify(before)}`);
  }

  await evaluate(`(()=>{
    const opener=[...document.querySelectorAll('#home .home-actions button')]
      .find(button=>button.textContent.trim()==='Settings');
    opener?.focus();
  })()`);
  await pressKey('Enter');
  await waitFor(`!!document.querySelector('.overlay.open [role="dialog"] button')`, 'Settings dialog');
  const initialDialog = await evaluate(`(()=>{
    const d=document.querySelector('.overlay.open [role="dialog"]');
    const owned=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==='Buy (stub)');
    return {name:d.getAttribute('aria-labelledby')?document.getElementById(d.getAttribute('aria-labelledby'))?.textContent:null,
      focus:document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent?.trim(),
      removeAds:owned&&{text:owned.textContent.trim(),disabled:owned.disabled,ariaDisabled:owned.getAttribute('aria-disabled')}};
  })()`);
  if (initialDialog.name !== 'Settings' || initialDialog.focus !== 'Mute sound' ||
      initialDialog.removeAds?.text !== 'Buy (stub)' || initialDialog.removeAds.disabled) {
    throw new Error(`Settings or initial Remove Ads state was unexpected: ${JSON.stringify(initialDialog)}`);
  }
  await pressKey('Tab');
  const focusedBuy = await evaluate(`(()=>{return {focus:document.activeElement?.textContent?.trim(),tag:document.activeElement?.tagName,isBuy:document.activeElement?.tagName==='BUTTON'&&document.activeElement?.textContent?.trim()==='Buy (stub)'}})()`);
  if (!focusedBuy.isBuy) throw new Error(`Tab did not focus Buy (stub): ${JSON.stringify(focusedBuy)}`);
  await pressKey('Enter');
  await waitFor(`JSON.parse(localStorage.getItem('hexpour_v1')||'{}').adsRemoved===true &&
    [...document.querySelectorAll('.overlay.open [role="dialog"] button')].some(b=>b.textContent.trim()==='Owned'&&b.disabled)`,
    'successful demo stub ownership and disabled Owned state');
  const after = await evaluate(`(()=>{
    const d=document.querySelector('.overlay.open [role="dialog"]');
    const owned=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==='Owned');
    const close=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==='Close');
    return {screen:[...document.querySelectorAll('.screen.active')].map(x=>x.id),dialog:d.getAttribute('aria-labelledby')?document.getElementById(d.getAttribute('aria-labelledby'))?.textContent:null,
      owned:owned&&{text:owned.textContent.trim(),disabled:owned.disabled,ariaDisabled:owned.getAttribute('aria-disabled')},
      focus:{isClose:document.activeElement===close,text:document.activeElement?.textContent?.trim(),focusVisible:document.activeElement?.matches(':focus-visible')},
      toast:{text:document.querySelector('.toast')?.textContent?.trim(),hidden:document.querySelector('.toast')?.hidden},
      storage:${stableStorageExpression()}};
  })()`);
  const expectedSettings = JSON.stringify({ unlocked: 3, adsRemoved: true, mute: true });
  if (after.screen.join(',') !== 'home' || after.dialog !== 'Settings' ||
      after.owned?.text !== 'Owned' || !after.owned.disabled || !after.focus.isClose || !after.focus.focusVisible ||
      after.toast.text !== 'Ads removed (stub)' || after.toast.hidden ||
      after.storage.settings !== expectedSettings || after.storage.progress !== progress ||
      after.storage.completion !== completion || after.storage.howto !== '1' ||
      JSON.stringify(after.storage.session) !== JSON.stringify(before.session)) {
    throw new Error(`Remove Ads success changed unexpected UI, focus or saved state: ${JSON.stringify({ before, after })}`);
  }

  await command('Page.reload', { ignoreCache: true });
  await waitFor(`!!document.querySelector('#home.screen.active .home-resume')`, 'saved run after reload');
  const afterReloadBeforeSettings = await evaluate(stableStorageExpression());
  if (afterReloadBeforeSettings.settings !== expectedSettings || afterReloadBeforeSettings.progress !== progress ||
      afterReloadBeforeSettings.completion !== completion || JSON.stringify(afterReloadBeforeSettings.session) !== JSON.stringify(before.session)) {
    throw new Error(`Saved run or preference state did not persist after reload: ${JSON.stringify(afterReloadBeforeSettings)}`);
  }
  await evaluate(`(()=>[...document.querySelectorAll('#home .home-actions button')].find(b=>b.textContent.trim()==='Settings')?.focus())()`);
  await pressKey('Enter');
  await waitFor(`!!document.querySelector('.overlay.open [role="dialog"]')`, 'Settings after reload');
  const afterReload = await evaluate(`(()=>{
    const d=document.querySelector('.overlay.open [role="dialog"]');
    const owned=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==='Owned');
    return {owned:owned&&{text:owned.textContent.trim(),disabled:owned.disabled},focus:document.activeElement?.textContent?.trim(),storage:${stableStorageExpression()}};
  })()`);
  if (afterReload.owned?.text !== 'Owned' || !afterReload.owned.disabled ||
      afterReload.storage.settings !== expectedSettings || afterReload.storage.progress !== progress ||
      afterReload.storage.completion !== completion || JSON.stringify(afterReload.storage.session) !== JSON.stringify(before.session)) {
    throw new Error(`Persisted Owned state did not render disabled or preserve the saved run: ${JSON.stringify(afterReload)}`);
  }

  await evaluate(`(()=>[...document.querySelectorAll('.overlay.open [role="dialog"] button')].find(b=>b.textContent.trim()==='Close')?.focus())()`);
  await pressKey('Enter');
  await waitFor(`!document.querySelector('.overlay.open')`, 'Settings close before saved-run verification');
  await evaluate(`(()=>[...document.querySelectorAll('#home .home-actions button')].find(b=>b.classList.contains('home-resume'))?.focus())()`);
  await pressKey('Enter');
  await waitFor(`document.querySelector('#play.screen.active .move-status')?.textContent==='Pours: 1'`, 'resume saved Level 2 with one Undo entry');
  const resumed = await evaluate(`(()=>({
    screen:[...document.querySelectorAll('.screen.active')].map(x=>x.id),
    level:document.querySelector('#play.screen.active .topbar .title')?.textContent?.trim(),
    pours:document.querySelector('#play.screen.active .move-status')?.textContent?.trim(),
    undoDisabled:document.querySelector('#play.screen.active .toolbar button')?.disabled,
    progress:localStorage.getItem('hexpour:in-progress'),
    focus:document.activeElement?.textContent?.trim()
  }))()`);
  if (resumed.screen.join(',') !== 'play' || resumed.level !== 'Level 2' || resumed.pours !== 'Pours: 1' ||
      resumed.undoDisabled || resumed.progress !== progress || resumed.focus !== 'Keyboard and screen reader controls') {
    throw new Error(`The persisted Level 2 run did not resume intact: ${JSON.stringify(resumed)}`);
  }
  await evaluate(`document.querySelector('#play.screen.active .toolbar button')?.focus()`);
  await pressKey('Enter');
  await waitFor(`document.querySelector('#play.screen.active .move-status')?.textContent==='Pours: 0'`, 'Undo restores the saved Level 2 baseline');
  const undone = await evaluate(`(()=>({
    pours:document.querySelector('#play.screen.active .move-status')?.textContent?.trim(),
    undoDisabled:document.querySelector('#play.screen.active .toolbar button')?.disabled,
    focusSummary:document.activeElement===document.querySelector('#play.screen.active .accessible-board > summary'),
    focusVisible:document.activeElement?.matches(':focus-visible'),
    progress:localStorage.getItem('hexpour:in-progress'),
    settings:localStorage.getItem('hexpour_v1'),
    completion:localStorage.getItem('hexpour:completed-levels')
  }))()`);
  if (undone.pours !== 'Pours: 0' || !undone.undoDisabled || !undone.focusSummary || !undone.focusVisible ||
      undone.progress !== null || undone.settings !== expectedSettings || undone.completion !== completion) {
    throw new Error(`The preserved Undo history did not operate safely after Remove Ads: ${JSON.stringify(undone)}`);
  }

  const nonLocalRequests = await evaluate(`performance.getEntriesByType('resource').map(r=>r.name).filter(name=>!name.startsWith(location.origin))`);
  if (nonLocalRequests.length) throw new Error(`Unexpected external resource request(s): ${JSON.stringify(nonLocalRequests)}`);
  console.log(JSON.stringify({
    status: 'PASS',
    target: url,
    profile: 'fresh disposable Chromium profile; origin storage verified empty before fixture; removed after test',
    initialStorage,
    syntheticBaseline: before,
    initialDialog,
    after,
    afterReloadBeforeSettings,
    afterReload,
    resumed,
    undone,
    nonLocalRequests,
    assertions: [
      'Buy (stub) is a local demo control; no external requests',
      'successful activation persists only adsRemoved among settings and immediately disables Owned',
      'keyboard focus moves deliberately to Close rather than falling to body when Buy becomes disabled',
      'success status is announced while Settings remains open',
      'Level 2 saved board and its one-entry Undo history are unchanged byte-for-byte',
      'unlock, mute, completion, How-to and session state are preserved',
      'Owned remains disabled after reload',
      'Home Resume restores the exact Level 2 run and Undo remains operable',
    ],
  }, null, 2));
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
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

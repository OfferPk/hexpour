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
if (!chromiumPath) throw new Error('Chromium was not found. Install Chromium or set CHROMIUM_BIN to its executable path.');

const requestedUrl = process.env.HEXPOUR_TEST_URL;
const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-level-select-chromium-'));
if ((await readdir(profileDirectory)).length !== 0) throw new Error('The disposable Chromium profile must be empty before launch.');
let server;
let browser;
let socket;
let nextCommandId = 0;
const pending = new Map();

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
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const diagnostic = await evaluate('({url:location.href,title:document.title,body:document.body?.innerText?.slice(0,180)})');
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}

async function pressKey(key, shift = false) {
  const virtualKey = ({ Tab: 9, Enter: 13, Escape: 27 })[key];
  const keyParams = {
    key,
    code: key,
    windowsVirtualKeyCode: virtualKey,
    nativeVirtualKeyCode: virtualKey,
    modifiers: shift ? 8 : 0,
  };
  await command('Input.dispatchKeyEvent', { type: 'keyDown', ...keyParams });
  if (key === 'Enter') {
    await command('Input.dispatchKeyEvent', {
      type: 'char', ...keyParams, text: '\r', unmodifiedText: '\r',
    });
  }
  await command('Input.dispatchKeyEvent', { type: 'keyUp', ...keyParams });
}

const focusExpression = `(() => {
  const el=document.activeElement;
  if(!el) return null;
  return {tag:el.tagName,label:el.getAttribute('aria-label'),text:(el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,100),className:typeof el.className==='string'?el.className:''};
})()`;
const storageExpression = `(() => {
  const read=s=>Object.fromEntries(Array.from({length:s.length},(_,i)=>s.key(i)).filter(k=>k!==null).sort().map(k=>[k,s.getItem(k)]));
  return {local:read(localStorage),session:read(sessionStorage)};
})()`;

try {
  let targetUrl = requestedUrl;
  if (!targetUrl) {
    server = await createServer({
      configFile: resolve(repoRoot, 'vite.config.ts'),
      root: repoRoot,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not provide a loopback TCP address.');
    targetUrl = `http://127.0.0.1:${address.port}/hexpour/`;
  }

  console.log(`Testing Level Select keyboard cancellation in a fresh Chromium profile: ${targetUrl}`);
  browser = spawn(chromiumPath, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore' });

  const devToolsPortFile = join(profileDirectory, 'DevToolsActivePort');
  let activePortContents;
  const portDeadline = Date.now() + 10_000;
  while (Date.now() < portDeadline) {
    if (browser.exitCode !== null) throw new Error('Chromium exited before its DevTools endpoint was ready.');
    try { activePortContents = await readFile(devToolsPortFile, 'utf8'); break; }
    catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  if (!activePortContents) throw new Error('Chromium did not create a DevTools endpoint.');
  const devToolsPort = Number(activePortContents.trim().split(/\s+/)[0]);
  let pageTarget;
  const targetDeadline = Date.now() + 10_000;
  while (Date.now() < targetDeadline && !pageTarget) {
    try {
      const response = await fetch(`http://127.0.0.1:${devToolsPort}/json/list`);
      pageTarget = (await response.json()).find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
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
  await command('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: targetUrl });
  await waitFor(`document.readyState==='complete' && !!document.querySelector('#app')`, 'the app shell');

  const settings = JSON.stringify({ unlocked: 3, adsRemoved: true, mute: true });
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
      { q: 0, r: 1, blocked: false, stack: [],
    } ] }],
  });
  const seedExpression = `(() => {
    localStorage.setItem('hexpour_v1',${JSON.stringify(settings)});
    localStorage.setItem('hexpour:in-progress',${JSON.stringify(progress)});
    localStorage.setItem('hexpour:howto','1');
    sessionStorage.setItem('hexpour:a2hs','1');
    return location.origin;
  })()`;
  await evaluate(seedExpression);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`!!document.querySelector('#home.screen.active') && !document.querySelector('.overlay.open')`, 'Home with the valid isolated saved-run fixture');
  await evaluate(`window.__levelSelectActivationCount=0; document.addEventListener('click',event=>{if(event.target instanceof Element && event.target.closest('.level-btn')) window.__levelSelectActivationCount++;},true);`);

  const initial = await evaluate(`({
    screen:[...document.querySelectorAll('.screen.active')].map(x=>x.id),
    settings:localStorage.getItem('hexpour_v1'),
    progress:localStorage.getItem('hexpour:in-progress'),
    resume:[...document.querySelectorAll('#home .home-actions button')].some(b=>b.textContent.trim().startsWith('Resume Level 2')),
  })`);
  if (initial.screen.join(',') !== 'home' || initial.settings !== settings || initial.progress !== progress || !initial.resume) {
    throw new Error(`The isolated valid run was not accepted intact: ${JSON.stringify(initial)}`);
  }
  const stateBefore = await evaluate(storageExpression);

  const homeFocuses = [];
  for (let i = 0; i < 3; i++) { await pressKey('Tab'); homeFocuses.push(await evaluate(focusExpression)); }
  const opener = homeFocuses.at(-1);
  if (opener?.text !== 'Levels') throw new Error(`Keyboard did not reach the Home Levels opener: ${JSON.stringify(homeFocuses)}`);
  await pressKey('Enter');
  await waitFor(`!!document.querySelector('#levels.screen.active')`, 'Level Select');
  const levelState = await evaluate(`({
    total:document.querySelectorAll('#levels .level-btn').length,
    unlocked:[...document.querySelectorAll('#levels .level-btn')].filter(b=>!b.disabled).length,
    locked:[...document.querySelectorAll('#levels .level-btn')].filter(b=>b.disabled).length,
    resume:[...document.querySelectorAll('#levels .level-btn')].some(b=>b.getAttribute('aria-label')==='Level 2, complete, in progress, resume with 1 pour'),
    playActive:!!document.querySelector('#play.screen.active'),
  })`);
  if (levelState.total !== 40 || levelState.unlocked !== 3 || levelState.locked !== 37 || !levelState.resume || levelState.playActive) {
    throw new Error(`Unexpected read-only Level Select contents: ${JSON.stringify(levelState)}`);
  }
  const choiceFocuses = [];
  for (let i = 0; i < 5; i++) { await pressKey('Tab'); choiceFocuses.push(await evaluate(focusExpression)); }
  const choices = choiceFocuses.filter((focus) => focus?.label?.startsWith('Level '));
  if (choices.length !== 3 || choices.map((focus) => focus.label.split(',')[0]).join('|') !== 'Level 1|Level 2|Level 3') {
    throw new Error(`Keyboard traversal did not reach only the first three unlocked choices: ${JSON.stringify(choiceFocuses)}`);
  }

  await pressKey('Escape');
  await waitFor(`!!document.querySelector('#home.screen.active') && document.activeElement?.classList.contains('level-select-opener')`, 'Escape to close Level Select and restore opener focus');
  const escapeResult = await evaluate(`({screen:[...document.querySelectorAll('.screen.active')].map(x=>x.id),focus:${focusExpression},playActive:!!document.querySelector('#play.screen.active')})`);
  const afterEscape = await evaluate(storageExpression);
  if (escapeResult.screen.join(',') !== 'home' || escapeResult.focus?.text !== 'Levels' || escapeResult.playActive ||
      JSON.stringify(afterEscape) !== JSON.stringify(stateBefore)) {
    throw new Error(`Escape changed focus, started a level, or changed persisted state: ${JSON.stringify({escapeResult,afterEscape})}`);
  }

  await pressKey('Enter');
  await waitFor(`!!document.querySelector('#levels.screen.active')`, 'Level Select reopened from its restored opener');
  const reopenFocuses = [];
  for (let i = 0; i < 5; i++) { await pressKey('Tab'); reopenFocuses.push(await evaluate(focusExpression)); }
  const lastChoice = reopenFocuses.at(-1);
  if (lastChoice?.label !== 'Level 3') throw new Error(`Could not reach the last unlocked choice by keyboard: ${JSON.stringify(reopenFocuses)}`);
  for (let i = 0; i < 4; i++) await pressKey('Tab', true);
  const backFocus = await evaluate(focusExpression);
  if (backFocus?.label !== 'Back to home') throw new Error(`Keyboard did not return to the Back control: ${JSON.stringify(backFocus)}`);
  await pressKey('Enter');
  await waitFor(`!!document.querySelector('#home.screen.active') && document.activeElement?.classList.contains('level-select-opener')`, 'Back to restore the Home Levels opener focus');
  const backResult = await evaluate(`({screen:[...document.querySelectorAll('.screen.active')].map(x=>x.id),focus:${focusExpression},playActive:!!document.querySelector('#play.screen.active'),levelActivations:window.__levelSelectActivationCount})`);
  const stateAfter = await evaluate(storageExpression);
  if (backResult.screen.join(',') !== 'home' || backResult.focus?.text !== 'Levels' || backResult.playActive ||
      backResult.levelActivations !== 0 || JSON.stringify(stateAfter) !== JSON.stringify(stateBefore)) {
    throw new Error(`Back changed focus, activated a level, or mutated stored state: ${JSON.stringify({backResult,stateAfter})}`);
  }

  console.log(JSON.stringify({
    status: 'PASS',
    target: targetUrl,
    profile: 'fresh empty disposable Chromium profile; removed after test',
    picker: { total: levelState.total, unlocked: levelState.unlocked, locked: levelState.locked, traversedByKeyboard: choices.map((focus) => focus.label) },
    escape: { returnedToHome: true, focusedOpener: escapeResult.focus.text, playNeverStarted: !escapeResult.playActive, exactStoragePreserved: true },
    back: { returnedToHome: true, focusedOpener: backResult.focus.text, playNeverStarted: !backResult.playActive, levelActivations: backResult.levelActivations, exactStoragePreserved: true },
    savedRun: { exactSnapshotPreserved: stateBefore.local['hexpour:in-progress'] === stateAfter.local['hexpour:in-progress'], undoHistoryEntries: JSON.parse(stateAfter.local['hexpour:in-progress']).undoStack.length },
    settingsAndUnlocks: stateBefore.local.hexpour_v1,
    storageKeys: { local: Object.keys(stateBefore.local), session: Object.keys(stateBefore.session) },
  }, null, 2));
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

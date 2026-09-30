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
const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-resume-level-'));
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

async function click(selector) {
  const target = await evaluate(`(()=>{
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!element)return null;
    const rect=element.getBoundingClientRect();
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2,disabled:element.disabled,text:element.innerText,aria:element.getAttribute('aria-label')};
  })()`);
  if (!target || target.disabled || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    throw new Error(`The expected clickable control was missing or disabled: ${selector} ${JSON.stringify(target)}`);
  }
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  return target;
}

const storageExpression = `(()=>{
  const read=s=>Object.fromEntries(Array.from({length:s.length},(_,i)=>s.key(i)).filter(k=>k!==null).sort().map(k=>[k,s.getItem(k)]));
  return {origin:location.origin,local:read(localStorage),session:read(sessionStorage)};
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

  console.log(`Testing saved Level 2 resume from Level Select in an empty disposable Chromium profile: ${targetUrl}`);
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
  await waitFor(`document.readyState==='complete'&&!!document.querySelector('#app')`, 'the Hexpour app shell');

  const initialStorage = await evaluate(storageExpression);
  if (Object.keys(initialStorage.local).length !== 0 || Object.keys(initialStorage.session).length !== 0) {
    throw new Error(`Origin local/session storage was not empty before synthetic data was seeded: ${JSON.stringify(initialStorage)}`);
  }

  const settings = JSON.stringify({ unlocked: 3, adsRemoved: true, mute: true });
  const progress = JSON.stringify({
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
    } ] }],
  });
  await evaluate(`(()=>{
    localStorage.setItem('hexpour_v1',${JSON.stringify(settings)});
    localStorage.setItem('hexpour:in-progress',${JSON.stringify(progress)});
    localStorage.setItem('hexpour:howto','1');
    sessionStorage.setItem('hexpour:a2hs','1');
    return true;
  })()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`!!document.querySelector('#home.screen.active')&&!document.querySelector('.overlay.open')`, 'Home with the synthetic saved run');

  const homeState = await evaluate(`({
    active:[...document.querySelectorAll('.screen.active')].map(screen=>screen.id),
    hasResume:[...document.querySelectorAll('#home .home-actions button')].some(button=>button.textContent.trim().startsWith('Resume Level 2')),
    storage:${storageExpression},
  })`);
  if (homeState.active.join(',') !== 'home' || !homeState.hasResume ||
      homeState.storage.local['hexpour_v1'] !== settings ||
      homeState.storage.local['hexpour:in-progress'] !== progress) {
    throw new Error(`The synthetic saved run did not reload intact: ${JSON.stringify(homeState)}`);
  }

  await click('#home .level-select-opener');
  await waitFor(`!!document.querySelector('#levels.screen.active')`, 'Level Select');
  const tile = await evaluate(`(()=>{
    const button=document.querySelector('#levels .level-btn.in-progress');
    return button?{label:button.getAttribute('aria-label'),text:button.innerText}:null;
  })()`);
  if (!tile?.label?.startsWith('Level 2,') || !tile.label.includes('resume with 1 pour')) {
    throw new Error(`Level Select did not present the expected resumable synthetic run: ${JSON.stringify(tile)}`);
  }
  await click('#levels .level-btn.in-progress');
  await waitFor(`!!document.querySelector('#play.screen.active')`, 'Level 2 after selecting its in-progress tile');
  const resumed = await evaluate(`(()=>{
    const active=document.activeElement;
    const summary=document.querySelector('#play .accessible-board > summary');
    const raw=localStorage.getItem('hexpour:in-progress');
    return {
      activeScreen:[...document.querySelectorAll('.screen.active')].map(screen=>screen.id),
      active:{tag:active?.tagName,id:active?.id,className:typeof active?.className==='string'?active.className:'',text:(active?.innerText||active?.textContent||'').trim().replace(/\\s+/g,' ').slice(0,100),visible:!!(active instanceof HTMLElement&&active.getClientRects().length),focusVisible:active instanceof HTMLElement&&active.matches(':focus-visible')},
      summary:{text:summary?.textContent,focused:active===summary,focusVisible:summary?.matches(':focus-visible')},
      moveStatus:document.querySelector('#play .move-status')?.textContent,
      undoDisabled:[...document.querySelectorAll('#play .toolbar button')].find(button=>button.textContent.trim()==='Undo')?.disabled,
      settings:localStorage.getItem('hexpour_v1'),
      progress:raw?JSON.parse(raw):null,
      session:Object.fromEntries(Array.from({length:sessionStorage.length},(_,i)=>sessionStorage.key(i)).filter(key=>key!==null).sort().map(key=>[key,sessionStorage.getItem(key)])),
    };
  })()`);
  if (resumed.activeScreen.join(',') !== 'play' || !resumed.summary.focused ||
      resumed.moveStatus !== 'Pours: 1' || resumed.undoDisabled !== false ||
      resumed.settings !== settings || JSON.stringify(resumed.progress) !== progress) {
    throw new Error(`Saved Level 2 did not resume with focus and all state intact: ${JSON.stringify(resumed)}`);
  }

  await click('#play .toolbar button:first-child');
  await waitFor(`document.querySelector('#play .move-status')?.textContent==='Pours: 0'`, 'Undo to restore the saved board to its start state');
  const afterUndo = await evaluate(`({
    activeScreen:[...document.querySelectorAll('.screen.active')].map(screen=>screen.id),
    moveStatus:document.querySelector('#play .move-status')?.textContent,
    undoDisabled:[...document.querySelectorAll('#play .toolbar button')].find(button=>button.textContent.trim()==='Undo')?.disabled,
    savedProgress:localStorage.getItem('hexpour:in-progress'),
    settings:localStorage.getItem('hexpour_v1'),
    unlocked:JSON.parse(localStorage.getItem('hexpour_v1')||'{}').unlocked,
  })`);
  if (afterUndo.activeScreen.join(',') !== 'play' || afterUndo.moveStatus !== 'Pours: 0' ||
      afterUndo.undoDisabled !== true || afterUndo.savedProgress !== null ||
      afterUndo.settings !== settings || afterUndo.unlocked !== 3) {
    throw new Error(`Undo after resume did not restore the initial board without touching settings/unlocks: ${JSON.stringify(afterUndo)}`);
  }

  console.log(JSON.stringify({
    initialStorageEmpty: true,
    initialStorage: initialStorage,
    syntheticRun: { levelId: 2, moveCount: 1, unlocked: 3, mute: true, adsRemoved: true },
    resumed,
    afterUndo,
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

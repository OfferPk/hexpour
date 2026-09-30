import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';

const repoRoot = process.cwd();
const chromiumPath = process.env.CHROMIUM_BIN || [
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome',
].find((candidate) => existsSync(candidate));
if (!chromiumPath) throw new Error('Chromium was not found.');
const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-restart-focus-'));
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
    }, 10000);
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) {
    throw new Error(response.result?.exception?.description || response.exceptionDetails.text);
  }
  return response.result?.value;
}
const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function waitFor(expression, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(await evaluate('({url:location.href,body:document.body?.innerText?.slice(0,240)})'))}`);
}
async function clickAtSelector(selector) {
  const rect = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height,disabled:e.disabled}})()`);
  if (!rect || rect.disabled || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`Not clickable: ${selector}: ${JSON.stringify(rect)}`);
  }
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, buttons: 0 });
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
  return rect;
}
const storageRead = `(storage)=>Object.fromEntries(Array.from({length:storage.length},(_,index)=>storage.key(index)).filter((key)=>key!==null).sort().map((key)=>[key,storage.getItem(key)]))`;

try {
  if ((await readdir(profileDirectory)).length !== 0) {
    throw new Error('Disposable Chromium profile directory was not empty before launch.');
  }
  check(true, 'Disposable Chromium profile directory is empty before launch');
  server = await createServer({
    configFile: resolve(repoRoot, 'vite.config.ts'),
    root: repoRoot,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not provide a loopback port.');
  const targetUrl = `http://127.0.0.1:${address.port}/hexpour/`;

  browser = spawn(chromiumPath, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(profileDirectory, 'DevToolsActivePort');
  let portContents;
  const portDeadline = Date.now() + 10000;
  while (Date.now() < portDeadline) {
    if (browser.exitCode !== null) throw new Error('Chromium exited before DevTools started.');
    try { portContents = await readFile(portFile, 'utf8'); break; }
    catch { await sleep(50); }
  }
  if (!portContents) throw new Error('Chromium did not create a DevTools endpoint.');
  const devToolsPort = Number(portContents.trim().split(/\s+/)[0]);
  let pageTarget;
  const targetDeadline = Date.now() + 10000;
  while (Date.now() < targetDeadline && !pageTarget) {
    try {
      pageTarget = (await (await fetch(`http://127.0.0.1:${devToolsPort}/json/list`)).json())
        .find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    } catch {}
    if (!pageTarget) await sleep(50);
  }
  if (!pageTarget) throw new Error('No page in the disposable Chromium profile.');
  socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
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

  await command('Page.enable');
  await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `(()=>{if(location.origin.startsWith('http://127.0.0.1:')){const read=${storageRead};try{window.__hexpourStorageAtDocumentStart={origin:location.origin,local:read(localStorage),session:read(sessionStorage)}}catch(error){window.__hexpourStorageAtDocumentStart={error:String(error)}}}})()`,
  });
  await command('Page.navigate', { url: targetUrl });
  await waitFor(`document.readyState==='complete'&&!!document.querySelector('#home.screen.active')`, 'initial Home screen');
  const originStorage = await evaluate(`({preBoot:window.__hexpourStorageAtDocumentStart,postBoot:{origin:location.origin,local:${storageRead}(localStorage),session:${storageRead}(sessionStorage)}})`);
  if (originStorage.preBoot?.error || Object.keys(originStorage.preBoot?.local || {}).length ||
      Object.keys(originStorage.preBoot?.session || {}).length ||
      Object.keys(originStorage.postBoot.local).length || Object.keys(originStorage.postBoot.session).length) {
    throw new Error(`Refusing to continue: fresh origin storage was not empty before synthetic setup: ${JSON.stringify(originStorage)}`);
  }
  check(true, 'Origin local/session storage is empty at document start before app code or synthetic setup', originStorage.preBoot);

  // Test-owned setup only after proving origin storage empty: skip unrelated first-run/A2HS UI and make saved settings/unlocks observable.
  const settings = JSON.stringify({ unlocked: 2, adsRemoved: false, mute: true });
  const completed = '[1]';
  await evaluate(`(()=>{localStorage.setItem('hexpour:howto','1');localStorage.setItem('hexpour_v1',${JSON.stringify(settings)});localStorage.setItem('hexpour:completed-levels',${JSON.stringify(completed)});sessionStorage.setItem('hexpour:a2hs','1')})()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`document.readyState==='complete'&&!!document.querySelector('#home.screen.active')&&!document.querySelector('.overlay.open [role="dialog"]')`, 'Home after isolated test setup');
  await clickAtSelector('#home .home-actions button');
  await waitFor(`!!document.querySelector('#play.screen.active .accessible-board > summary')`, 'fresh Level 2 play screen');
  const before = await evaluate(`(()=>({screen:[...document.querySelectorAll('.screen.active')].map((node)=>node.id),level:document.querySelector('#play .topbar .title')?.textContent.trim(),move:document.querySelector('#play .move-status')?.textContent.trim(),undoDisabled:[...document.querySelectorAll('#play .toolbar button')].find((button)=>button.textContent.trim()==='Undo')?.disabled,progress:localStorage.getItem('hexpour:in-progress'),settings:localStorage.getItem('hexpour_v1'),completed:localStorage.getItem('hexpour:completed-levels'),session:${storageRead}(sessionStorage),focusIsSummary:document.activeElement===document.querySelector('#play .accessible-board > summary'),board:[...document.querySelectorAll('#play .cell-control')].map((button)=>button.getAttribute('aria-label'))}))()`);
  if (before.screen.join(',') !== 'play' || before.level !== 'Level 2' || before.move !== 'Pours: 0' ||
      before.undoDisabled !== true || before.progress !== null || !before.focusIsSummary) {
    throw new Error(`Unexpected fresh game precondition: ${JSON.stringify(before)}`);
  }
  check(true, 'Fresh Level 2 is untouched, has no saved run or Undo history, and begins with play-controls focus', {
    screen: before.screen, level: before.level, move: before.move, undoDisabled: before.undoDisabled,
    progress: before.progress, focusIsSummary: before.focusIsSummary,
  });
  await evaluate(`window.__restartBefore={summary:document.querySelector('#play .accessible-board > summary'),restart:document.querySelector('#play .toolbar button:last-child')}`);
  const clickRect = await clickAtSelector('#play .toolbar button:last-child');
  await waitFor(`document.querySelector('#play.screen.active .accessible-board > summary')!==window.__restartBefore.summary`, 'untouched-board immediate restart');
  const after = await evaluate(`(()=>({screen:[...document.querySelectorAll('.screen.active')].map((node)=>node.id),level:document.querySelector('#play .topbar .title')?.textContent.trim(),move:document.querySelector('#play .move-status')?.textContent.trim(),undoDisabled:[...document.querySelectorAll('#play .toolbar button')].find((button)=>button.textContent.trim()==='Undo')?.disabled,progress:localStorage.getItem('hexpour:in-progress'),settings:localStorage.getItem('hexpour_v1'),completed:localStorage.getItem('hexpour:completed-levels'),session:${storageRead}(sessionStorage),overlayOpen:document.querySelector('.overlay.open')!==null,oldRestartConnected:window.__restartBefore.restart?.isConnected,focusTag:document.activeElement?.tagName,focusText:(document.activeElement?.textContent||'').trim(),focusIsSummary:document.activeElement===document.querySelector('#play .accessible-board > summary'),newSummary:document.querySelector('#play .accessible-board > summary')!==window.__restartBefore.summary,board:[...document.querySelectorAll('#play .cell-control')].map((button)=>button.getAttribute('aria-label'))}))()`);
  const sameBoard = JSON.stringify(before.board) === JSON.stringify(after.board);
  check(sameBoard && after.screen.join(',') === 'play' && after.level === 'Level 2' && after.move === 'Pours: 0' &&
    after.undoDisabled === true && after.progress === null && after.settings === settings && after.completed === completed &&
    JSON.stringify(after.session) === JSON.stringify(before.session) && !after.overlayOpen,
  'Immediate restart preserves the untouched board, move/Undo/save state, settings, unlocks, and session state', {
    sameBoard, screen: after.screen, level: after.level, move: after.move, undoDisabled: after.undoDisabled,
    progress: after.progress, settings: after.settings, completed: after.completed, overlayOpen: after.overlayOpen,
  });
  check(after.focusIsSummary, 'Mouse-activated immediate restart restores focus to the new keyboard-controls summary', {
    focusTag: after.focusTag, focusText: after.focusText, focusIsSummary: after.focusIsSummary,
    oldRestartConnected: after.oldRestartConnected, newSummary: after.newSummary, clickRect,
  });
  const failed = checks.filter(({ ok }) => !ok);
  console.log(JSON.stringify({
    status: failed.length ? 'FAIL' : 'PASS',
    target: targetUrl,
    interaction: 'mouse activation of Restart on an untouched Level 2; no pour, Undo, saved-run resume, or keyboard input sent',
    profile: 'new disposable Chromium profile; verified empty before app setup and removed after test',
    originStorage,
    before: { screen: before.screen, level: before.level, move: before.move, undoDisabled: before.undoDisabled,
      progress: before.progress, focusIsSummary: before.focusIsSummary },
    after: { screen: after.screen, level: after.level, move: after.move, undoDisabled: after.undoDisabled,
      progress: after.progress, settings: after.settings, completed: after.completed,
      focusTag: after.focusTag, focusText: after.focusText, focusIsSummary: after.focusIsSummary,
      oldRestartConnected: after.oldRestartConnected },
    checks,
    spokenScreenReaderOutput: 'not tested; DOM focus target and visible interface state only',
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
      sleep(1500),
    ]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  }
  if (server) await server.close();
  await sleep(100);
  await rm(profileDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

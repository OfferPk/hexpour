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
const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-selection-cancel-'));
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
  const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.result?.exception?.description || response.exceptionDetails.text);
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

async function pressKey(key) {
  const virtualKey = ({ Tab: 9, Enter: 13, Escape: 27 })[key];
  const keyParams = { key, code: key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey };
  await command('Input.dispatchKeyEvent', { type: 'keyDown', ...keyParams });
  if (key === 'Enter') {
    await command('Input.dispatchKeyEvent', { type: 'char', ...keyParams, text: '\r', unmodifiedText: '\r' });
  }
  await command('Input.dispatchKeyEvent', { type: 'keyUp', ...keyParams });
}

const stateExpression = `(() => {
  const play=document.querySelector('#play.screen.active');
  if(!play) return null;
  const controls=[...play.querySelectorAll('.cell-control')];
  const at=(q,r)=>controls.find(b=>b.getAttribute('aria-label')?.startsWith('Hex cell q '+q+', r '+r+':'));
  const source=at(0,0), destination=at(1,0);
  const undo=[...play.querySelectorAll('.toolbar button')].find(b=>b.textContent.trim()==='Undo');
  const normalize=label=>label?.replace(' Selected source. Press again to deselect.','').replace(' Legal destination from selected source. Press to pour.','').replace(' Blocked adjacent cell. Cannot be used as a destination.','');
  const canvas=play.querySelector('.play-canvas-wrap canvas');
  let canvasHash=null;
  if(canvas?.width&&canvas?.height){
    const pixels=canvas.getContext('2d')?.getImageData(0,0,canvas.width,canvas.height).data;
    if(pixels){let hash=2166136261;for(let i=0;i<pixels.length;i+=4){hash=Math.imul(hash^pixels[i],16777619);hash=Math.imul(hash^pixels[i+1],16777619);hash=Math.imul(hash^pixels[i+2],16777619);hash=Math.imul(hash^pixels[i+3],16777619);}canvasHash=(hash>>>0).toString(16);}
  }
  const active=document.activeElement;
  const progress=localStorage.getItem('hexpour:in-progress');
  return {
    source:{label:source?.getAttribute('aria-label'),base:normalize(source?.getAttribute('aria-label')),pressed:source?.getAttribute('aria-pressed'),selected:source?.classList.contains('selected'),focus:active===source,focusVisible:source?.matches(':focus-visible')||false},
    destination:{label:destination?.getAttribute('aria-label'),base:normalize(destination?.getAttribute('aria-label')),legal:destination?.classList.contains('legal-target'),focus:active===destination,focusVisible:destination?.matches(':focus-visible')||false},
    board:controls.map(b=>[normalize(b.getAttribute('aria-label')),b.disabled]),
    selectionText:play.querySelector('.screen-reader-status')?.textContent,
    selectionRole:play.querySelector('.screen-reader-status')?.getAttribute('role'),
    selectionLive:play.querySelector('.screen-reader-status')?.getAttribute('aria-live'),
    selectionAtomic:play.querySelector('.screen-reader-status')?.getAttribute('aria-atomic'),
    moveStatus:play.querySelector('.move-status')?.textContent,
    undoDisabled:undo?.disabled,
    settings:localStorage.getItem('hexpour_v1'),
    progress,
    progressSummary:progress?((p)=>({levelId:p.levelId,moveCount:p.moveCount,undoCount:p.undoStack?.length}))(JSON.parse(progress)):null,
    canvasHash
  };
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
  await waitFor(`document.readyState==='complete'&&!!document.querySelector('#app')`, 'the HexPour app shell');

  const settings = JSON.stringify({ unlocked: 3, adsRemoved: true, mute: true });
  const savedRun = JSON.stringify({
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
  await evaluate(`(()=>{localStorage.setItem('hexpour_v1',${JSON.stringify(settings)});localStorage.setItem('hexpour:in-progress',${JSON.stringify(savedRun)});localStorage.setItem('hexpour:howto','1');sessionStorage.setItem('hexpour:a2hs','1');return true})()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`!!document.querySelector('#home.screen.active button.home-resume')`, 'Home with the valid Level 2 saved run');
  const resumed = await evaluate(`(()=>{const b=document.querySelector('#home.screen.active button.home-resume');if(!b)return false;b.click();return true})()`);
  if (!resumed) throw new Error('The Level 2 saved-run Resume control was unavailable.');
  await waitFor(`document.querySelector('#play.screen.active .topbar .title')?.textContent.trim()==='Level 2'`, 'resumed Level 2');
  await evaluate(`(()=>{const s=document.querySelector('#play.screen.active details.accessible-board summary');if(!s)return false;s.click();s.focus();return true})()`);
  await waitFor(`document.querySelector('#play.screen.active details.accessible-board')?.open`, 'the accessible cell controls');

  await evaluate('new Promise(resolveFrame=>requestAnimationFrame(()=>requestAnimationFrame(resolveFrame)))');
  const before = await evaluate(stateExpression);
  if (before.moveStatus !== 'Pours: 1' || before.undoDisabled || before.progress !== savedRun || before.settings !== settings) {
    throw new Error(`The isolated Level 2 fixture was not restored intact: ${JSON.stringify(before)}`);
  }
  await pressKey('Tab');
  const focusedSource = await evaluate(stateExpression);
  if (!focusedSource.source.focus || !focusedSource.source.focusVisible) {
    throw new Error(`Tab did not focus the Level 2 source visibly: ${JSON.stringify(focusedSource.source)}`);
  }
  await pressKey('Enter');
  await waitFor(`document.querySelector('#play.screen.active .cell-control[aria-pressed="true"]')`, 'source selection');
  await evaluate('new Promise(resolveFrame=>requestAnimationFrame(()=>requestAnimationFrame(resolveFrame)))');
  const selected = await evaluate(stateExpression);
  if (selected.source.pressed !== 'true' || !selected.source.selected || !selected.source.focus ||
      !selected.destination.legal || !selected.selectionText?.includes('Selected source: Hex cell q 0, r 0.') ||
      selected.selectionRole !== 'status' || selected.selectionLive !== 'polite' || selected.selectionAtomic !== 'true' ||
      selected.canvasHash === before.canvasHash) {
    throw new Error(`Source selection cues or focus were missing: ${JSON.stringify(selected)}`);
  }

  await pressKey('Escape');
  await evaluate('new Promise(resolveFrame=>requestAnimationFrame(()=>requestAnimationFrame(resolveFrame)))');
  const afterEscape = await evaluate(stateExpression);
  const deselected = afterEscape.source.pressed === 'false' && !afterEscape.source.selected &&
    !afterEscape.destination.legal && afterEscape.selectionText === '';
  const focusPreserved = afterEscape.source.focus && afterEscape.source.focusVisible;
  const exactCancelPreservation = JSON.stringify(afterEscape.board) === JSON.stringify(before.board) &&
    afterEscape.moveStatus === before.moveStatus && afterEscape.undoDisabled === before.undoDisabled &&
    afterEscape.progress === before.progress && afterEscape.settings === before.settings;
  const visualCueCleared = afterEscape.canvasHash === before.canvasHash;
  if (!deselected || !focusPreserved || !exactCancelPreservation || !visualCueCleared) {
    throw new Error(`Escape failed source-only cancellation: ${JSON.stringify({ afterEscape, deselected, focusPreserved, exactCancelPreservation, visualCueCleared })}`);
  }

  await pressKey('Enter');
  await waitFor(`document.querySelector('#play.screen.active .cell-control[aria-pressed="true"]')`, 'source reselection after Escape');
  const reselected = await evaluate(stateExpression);
  if (!reselected.source.selected || !reselected.destination.legal || !reselected.source.focus) {
    throw new Error(`Reselection did not restore the source and legal target cues: ${JSON.stringify(reselected)}`);
  }
  await pressKey('Tab');
  const focusedDestination = await evaluate(stateExpression);
  if (!focusedDestination.destination.focus || !focusedDestination.destination.focusVisible || !focusedDestination.destination.legal) {
    throw new Error(`Tab did not focus the legal destination: ${JSON.stringify(focusedDestination.destination)}`);
  }
  await pressKey('Enter');
  await waitFor(`document.querySelector('#play.screen.active .move-status')?.textContent==='Pours: 2'`, 'legal Level 2 move after Escape and reselection');
  const afterLegalMove = await evaluate(stateExpression);
  if (afterLegalMove.progressSummary?.levelId !== 2 || afterLegalMove.progressSummary?.moveCount !== 2 ||
      afterLegalMove.progressSummary?.undoCount !== 2 || afterLegalMove.undoDisabled ||
      afterLegalMove.settings !== before.settings || JSON.stringify(afterLegalMove.board) === JSON.stringify(before.board)) {
    throw new Error(`The legal move did not work cleanly after Escape/reselection: ${JSON.stringify(afterLegalMove)}`);
  }

  console.log(JSON.stringify({
    status: 'PASS',
    target: targetUrl,
    profile: 'fresh disposable Chromium profile; removed after test',
    selection: { keyboardSourceFocus: true, selectedCue: true, legalDestinationCue: true, liveStatus: selected.selectionText },
    escape: { deselectedOnly: true, keyboardFocusPreserved: true, visualCueCleared: true, exactBoardAndHistoryPreserved: true, exactSavedSnapshotPreserved: true, exactSettingsAndUnlocksPreserved: true },
    reselectAndMove: { keyboardReselection: true, legalDestinationFocused: true, moveCount: afterLegalMove.progressSummary.moveCount, undoAvailable: !afterLegalMove.undoDisabled },
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

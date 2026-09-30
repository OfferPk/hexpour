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

if (!chromiumPath) {
  throw new Error('Chromium was not found. Install Chromium or set CHROMIUM_BIN to its executable path.');
}

const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-blocked-chromium-'));
if ((await readdir(profileDirectory)).length !== 0) {
  throw new Error('The temporary Chromium profile must be empty before launch.');
}

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

async function waitFor(expression, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const diagnostic = await evaluate(`({url:location.href,title:document.title,body:document.body?.innerText?.slice(0,180),frameSrc:document.querySelector('#game')?.src,frameReady:document.querySelector('#game')?.contentDocument?.readyState,frameTitle:document.querySelector('#game')?.contentDocument?.title,activeScreens:[...(document.querySelector('#game')?.contentDocument?.querySelectorAll('.screen.active')||[])].map(x=>x.id)})`);
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}

async function pressEnter() {
  const keyParams = {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
  await command('Input.dispatchKeyEvent', { type: 'keyDown', ...keyParams });
  await command('Input.dispatchKeyEvent', {
    type: 'char', ...keyParams, text: '\r', unmodifiedText: '\r',
  });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', ...keyParams });
}

const stateExpression = `(() => {
  const frame=document.querySelector('#game');
  const d=frame?.contentDocument;
  const w=frame?.contentWindow;
  const play=d?.querySelector('#play.screen.active');
  if(!d || !w || !play) return null;
  const controls=[...play.querySelectorAll('details.accessible-board button.cell-control')];
  const at=(q,r)=>controls.find(b=>b.getAttribute('aria-label')?.startsWith('Hex cell q '+q+', r '+r+':'));
  const source=at(0,0), hole=at(-1,1), legal=at(1,-1);
  const undo=[...play.querySelectorAll('.toolbar button')].find(b=>b.textContent.trim()==='Undo');
  const selectionStatus=play.querySelector('.screen-reader-status');
  const toast=d.querySelector('.toast');
  const canvas=play.querySelector('.play-canvas-wrap canvas');
  let canvasHash=null;
  if(canvas?.width && canvas?.height){
    const pixels=canvas.getContext('2d')?.getImageData(0,0,canvas.width,canvas.height).data;
    if(pixels){ let hash=2166136261; for(let i=0;i<pixels.length;i+=4){ hash=Math.imul(hash^pixels[i],16777619); hash=Math.imul(hash^pixels[i+1],16777619); hash=Math.imul(hash^pixels[i+2],16777619); hash=Math.imul(hash^pixels[i+3],16777619); } canvasHash=(hash>>>0).toString(16); }
  }
  const normalize=label=>label?.replace(/ Selected source\\..*$/,'').replace(/ Legal destination from selected source\\..*$/,'').replace(/ Blocked adjacent cell\\..*$/,'');
  return {
    level:play.querySelector('.topbar .title')?.textContent.trim(),
    sourceLabel:source?.getAttribute('aria-label'), sourcePressed:source?.getAttribute('aria-pressed'), sourceSelected:source?.classList.contains('selected'),
    holeLabel:hole?.getAttribute('aria-label'), holeDisabled:hole?.disabled, holeVisual:hole?.classList.contains('blocked-target'),
    legalLabel:legal?.getAttribute('aria-label'), legalVisual:legal?.classList.contains('legal-target'),
    selectionText:selectionStatus?.textContent, selectionRole:selectionStatus?.getAttribute('role'), selectionLive:selectionStatus?.getAttribute('aria-live'), selectionAtomic:selectionStatus?.getAttribute('aria-atomic'),
    toastText:toast?.textContent, toastRole:toast?.getAttribute('role'), toastLive:toast?.getAttribute('aria-live'), toastAtomic:toast?.getAttribute('aria-atomic'),
    moveStatus:play.querySelector('.move-status')?.textContent, undoDisabled:undo?.disabled,
    settings:w.localStorage.getItem('hexpour_v1'), progress:w.localStorage.getItem('hexpour:in-progress'),
    board:controls.map(b=>[normalize(b.getAttribute('aria-label')),b.disabled]),
    activeCell:controls.indexOf(d.activeElement), canvasHash,
  };
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
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a loopback TCP address.');
  const fixtureUrl = `http://127.0.0.1:${address.port}/hexpour/tests/browser/isolated-app-host.html`;

  console.log(`Running blocked-destination regression in a fresh Chromium profile: ${chromiumPath}`);
  browser = spawn(chromiumPath, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore' });

  const devToolsPortFile = join(profileDirectory, 'DevToolsActivePort');
  let activePortContents;
  const portDeadline = Date.now() + 10000;
  while (Date.now() < portDeadline) {
    if (browser.exitCode !== null) throw new Error('Chromium exited before its DevTools endpoint was ready.');
    try { activePortContents = await readFile(devToolsPortFile, 'utf8'); break; }
    catch { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); }
  }
  if (!activePortContents) throw new Error('Chromium did not create its DevTools endpoint.');
  const devToolsPort = Number(activePortContents.trim().split(/\s+/)[0]);
  let pageTarget;
  const targetDeadline = Date.now() + 10000;
  while (Date.now() < targetDeadline && !pageTarget) {
    try {
      const response = await fetch(`http://127.0.0.1:${devToolsPort}/json/list`);
      pageTarget = (await response.json()).find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); }
  }
  if (!pageTarget) throw new Error('Could not find Chromium page target.');

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
    const timer = setTimeout(() => rejectOpen(new Error('DevTools WebSocket open timed out.')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('Could not connect to Chromium DevTools.')); }, { once: true });
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: fixtureUrl });
  await waitFor(`(() => !!document.querySelector('#game')?.contentDocument?.querySelector('#home.screen.active'))()`, 'the app home screen in the isolated local iframe');

  const settingsSeed = JSON.stringify({ unlocked: 11, adsRemoved: true, mute: true });
  await evaluate(`(() => {
    const frame=document.querySelector('#game');
    localStorage.setItem('hexpour_v1', ${JSON.stringify(settingsSeed)});
    localStorage.removeItem('hexpour:in-progress');
    return new Promise(resolveReload => {
      frame.addEventListener('load', () => resolveReload(true), { once: true });
      frame.contentWindow.location.reload();
    });
  })()`);
  await waitFor(`(() => !!document.querySelector('#game')?.contentDocument?.querySelector('#home.screen.active .home-actions .level-select-opener'))()`, 'Home with the seeded Level 11 unlocks');

  const openedLevels = await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const b=[...d.querySelectorAll('#home.screen.active button')].find(x=>x.textContent.trim()==='Levels'); if(!b)return false; b.click(); return true; })()`);
  if (!openedLevels) throw new Error('Home Levels control was not available.');
  await waitFor(`(() => !!document.querySelector('#game')?.contentDocument?.querySelector('#levels.screen.active'))()`, 'the level picker');
  const openedLevel = await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const b=[...d.querySelectorAll('#levels.screen.active button')].find(x=>x.getAttribute('aria-label')==='Level 11'); if(!b||b.disabled)return false; b.click(); return true; })()`);
  if (!openedLevel) throw new Error('Level 11 was not selectable from the isolated unlocked state.');
  await waitFor(`(() => { const d=document.querySelector('#game')?.contentDocument; return d?.querySelector('#play.screen.active .topbar .title')?.textContent.trim()==='Level 11'; })()`, 'Level 11');
  await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const details=d.querySelector('#play.screen.active details.accessible-board'); if(details&&!details.open)details.querySelector('summary').click(); return true; })()`);
  await waitFor(`(() => document.querySelector('#game')?.contentDocument?.querySelector('#play.screen.active details.accessible-board')?.open)()`, 'the accessible cell controls');

  const initial = await evaluate(stateExpression);
  if (initial.level !== 'Level 11' || !initial.sourceLabel?.includes('tokens bottom to top red, red, blue') ||
      !initial.holeLabel?.includes('blocked hole') || initial.holeDisabled !== true ||
      !initial.legalLabel?.includes('empty') || initial.moveStatus !== 'Pours: 0' ||
      initial.undoDisabled !== true || initial.settings !== settingsSeed || initial.progress !== null) {
    throw new Error(`Unexpected isolated Level 11 starting state: ${JSON.stringify(initial)}`);
  }

  const focusedSource = await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const b=[...d.querySelectorAll('#play.screen.active .cell-control')].find(x=>x.getAttribute('aria-label')?.startsWith('Hex cell q 0, r 0:')); b.focus(); return d.activeElement===b; })()`);
  if (!focusedSource) throw new Error('Could not focus the source control.');
  await pressEnter();
  await waitFor(`(() => { const d=document.querySelector('#game')?.contentDocument; const s=d?.querySelector('#play.screen.active .screen-reader-status'); const c=[...d?.querySelectorAll('#play.screen.active .cell-control')||[]]; const at=(q,r)=>c.find(b=>b.getAttribute('aria-label')?.startsWith('Hex cell q '+q+', r '+r+':')); return at(0,0)?.getAttribute('aria-pressed')==='true' && s?.textContent.includes('Selected source: Hex cell q 0, r 0.'); })()`, 'keyboard source selection and its status announcement');
  const selected = await evaluate(stateExpression);
  if (!selected.sourceSelected || !selected.holeVisual || !selected.legalVisual ||
      selected.selectionRole !== 'status' || selected.selectionLive !== 'polite' || selected.selectionAtomic !== 'true' ||
      !selected.selectionText?.includes('Blocked adjacent cell: Hex cell q -1, r 1.') || !selected.canvasHash) {
    throw new Error(`Source-selection visual/live feedback failed: ${JSON.stringify(selected)}`);
  }

  const blockedPointer = await evaluate(`(() => {
    const frame=document.querySelector('#game'), d=frame.contentDocument, w=frame.contentWindow;
    const wrap=d.querySelector('#play.screen.active .play-canvas-wrap'), canvas=wrap.querySelector('canvas');
    const controls=[...d.querySelectorAll('#play.screen.active .cell-control')];
    const coords=controls.map(b=>{const m=b.getAttribute('aria-label')?.match(/^Hex cell q (-?\\d+), r (-?\\d+):/);return m?{q:+m[1],r:+m[2]}:null}).filter(Boolean);
    const px=(q,r,s)=>({x:s*1.5*q,y:s*(Math.sqrt(3)/2*q+Math.sqrt(3)*r)});
    const probe=20, points=coords.map(c=>px(c.q,c.r,probe));
    const minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x));
    const minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y));
    const cw=wrap.clientWidth,ch=wrap.clientHeight,bw=maxX-minX+40,bh=maxY-minY+40;
    const size=Math.min((cw-32)/(bw/probe),(ch-32)/(bh/probe));
    const positions=coords.map(c=>px(c.q,c.r,size));
    const ox=cw/2-positions.reduce((sum,p)=>sum+p.x,0)/positions.length;
    const oy=ch/2-positions.reduce((sum,p)=>sum+p.y,0)/positions.length;
    const target=px(-1,1,size),rect=canvas.getBoundingClientRect();
    canvas.dispatchEvent(new w.PointerEvent('pointerup',{bubbles:true,clientX:rect.left+ox+target.x,clientY:rect.top+oy+target.y,pointerId:1,pointerType:'mouse',isPrimary:true}));
    return true;
  })()`);
  if (!blockedPointer) throw new Error('Could not send the blocked-hole pointer interaction.');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  const afterBlocked = await evaluate(stateExpression);
  if (afterBlocked.sourcePressed !== 'true' || !afterBlocked.sourceSelected ||
      !afterBlocked.holeVisual || !afterBlocked.legalVisual ||
      afterBlocked.selectionText !== selected.selectionText || afterBlocked.activeCell < 0 ||
      afterBlocked.toastText !== 'Blocked cell' || afterBlocked.toastRole !== 'status' ||
      afterBlocked.toastLive !== 'polite' || afterBlocked.toastAtomic !== 'true') {
    throw new Error(`Blocked attempt lost selection or accessible/visual feedback: ${JSON.stringify(afterBlocked)}`);
  }
  if (afterBlocked.board.some((cell, index) => JSON.stringify(cell) !== JSON.stringify(initial.board[index])) ||
      afterBlocked.moveStatus !== 'Pours: 0' || afterBlocked.undoDisabled !== true ||
      afterBlocked.settings !== initial.settings || afterBlocked.progress !== initial.progress ||
      afterBlocked.canvasHash !== selected.canvasHash) {
    throw new Error(`Blocked attempt changed the board, Undo, saved progress, settings, or canvas selection: ${JSON.stringify(afterBlocked)}`);
  }

  const focusedLegalDestination = await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const b=[...d.querySelectorAll('#play.screen.active .cell-control')].find(x=>x.getAttribute('aria-label')?.startsWith('Hex cell q 1, r -1:')); if(!b||!b.classList.contains('legal-target'))return false; b.focus(); return d.activeElement===b; })()`);
  if (!focusedLegalDestination) throw new Error('The legal destination was not available while the original source remained selected.');
  await pressEnter();
  await waitFor(`(() => document.querySelector('#game')?.contentDocument?.querySelector('#play.screen.active .move-status')?.textContent==='Pours: 1')()`, 'the legal adjacent pour');
  const afterLegal = await evaluate(stateExpression);
  const savedProgress = afterLegal.progress ? JSON.parse(afterLegal.progress) : null;
  if (afterLegal.undoDisabled !== false || afterLegal.settings !== initial.settings ||
      savedProgress?.levelId !== 11 || savedProgress?.moveCount !== 1 ||
      afterLegal.sourceLabel?.includes('blue') || !afterLegal.legalLabel?.includes('blue')) {
    throw new Error(`Legal pour/save behavior failed: ${JSON.stringify(afterLegal)}`);
  }

  const focusedUndo = await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const b=[...d.querySelectorAll('#play.screen.active .toolbar button')].find(x=>x.textContent.trim()==='Undo'); b?.focus(); return d.activeElement===b; })()`);
  if (!focusedUndo) throw new Error('Could not focus Undo after a legal pour.');
  await pressEnter();
  await waitFor(`(() => { const d=document.querySelector('#game')?.contentDocument; const b=[...d.querySelectorAll('#play.screen.active .cell-control')].find(x=>x.getAttribute('aria-label')?.startsWith('Hex cell q 0, r 0:')); return d?.querySelector('#play.screen.active .move-status')?.textContent==='Pours: 0' && d.defaultView.localStorage.getItem('hexpour:in-progress')===null && b?.getAttribute('aria-label')?.includes('red, red, blue'); })()`, 'Undo restoring the source stack and clearing the in-progress snapshot');
  const afterUndo = await evaluate(stateExpression);
  if (afterUndo.undoDisabled !== true || afterUndo.settings !== initial.settings || afterUndo.progress !== null ||
      !afterUndo.sourceLabel?.includes('red, red, blue') || !afterUndo.legalLabel?.includes('empty')) {
    throw new Error(`Undo did not restore the original board/save/settings: ${JSON.stringify(afterUndo)}`);
  }

  console.log('PASS blocked destination preserves source selection, live status, visual targets, save state, and focus.');
  console.log('PASS legal pour succeeds without reselection; Undo restores the exact board and removes its snapshot.');
  console.log('PASS unlock/settings storage is unchanged through the interaction sequence.');
  console.log(`Local-only origin: http://127.0.0.1:${address.port}/hexpour/`);
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
} finally {
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveClose) => browser.once('close', resolveClose)),
      new Promise((resolveWait) => setTimeout(resolveWait, 1500)),
    ]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  }
  if (server) await server.close();
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  await rm(profileDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

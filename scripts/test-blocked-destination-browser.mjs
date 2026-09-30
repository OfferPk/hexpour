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
    toastShown:toast?.classList.contains('show'), toastHidden:toast?.hidden,
    toastDisplay:toast?getComputedStyle(toast).display:null,
    toastTimers:(()=>{const p=w.__hexpourToastTimerProbe;if(!p)return null;return{scheduled:p.scheduled.length,cancelled:p.cancelled.length,fired:p.fired.length,pending:p.scheduled.filter(id=>!p.cancelled.includes(id)&&!p.fired.includes(id)).length};})(),
    moveStatus:play.querySelector('.move-status')?.textContent,
    moveStatusLive:play.querySelector('.move-status')?.getAttribute('aria-live'),
    moveStatusAtomic:play.querySelector('.move-status')?.getAttribute('aria-atomic'),
    undoDisabled:undo?.disabled,
    settings:w.localStorage.getItem('hexpour_v1'), progress:w.localStorage.getItem('hexpour:in-progress'),
    board:controls.map(b=>[normalize(b.getAttribute('aria-label')),b.disabled]),
    activeCell:controls.indexOf(d.activeElement), activeCellLabel:d.activeElement?.getAttribute('aria-label'), canvasHash,
  };
})()`;

const blockedPointerExpression = `(() => {
  const frame=document.querySelector('#game'), d=frame.contentDocument, w=frame.contentWindow;
  const wrap=d.querySelector('#play.screen.active .play-canvas-wrap'), canvas=wrap.querySelector('canvas');
  const controls=[...d.querySelectorAll('#play.screen.active .cell-control')];
  const coords=controls.map(b=>{const m=b.getAttribute('aria-label')?.match(/^Hex cell q (-?\\d+), r (-?\\d+):/);return m?{q:+m[1],r:+m[2]}:null}).filter(Boolean);
  const px=(q,r,s)=>({x:s*1.5*q,y:s*(Math.sqrt(3)/2*q+Math.sqrt(3)*r)});
  const probe=20,points=coords.map(c=>px(c.q,c.r,probe));
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
})()`;

async function blockedAttempt() {
  if (!await evaluate(blockedPointerExpression)) throw new Error('Could not send the blocked-hole pointer interaction.');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  return await evaluate(stateExpression);
}

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
  if (initial.level !== 'Level 11' || !initial.sourceLabel?.includes('bottom to top red, red, blue') ||
      !initial.holeLabel?.includes('blocked hole') || initial.holeDisabled !== true ||
      !initial.legalLabel?.includes('empty') || initial.moveStatus !== 'Pours: 0' ||
      initial.undoDisabled !== true || initial.settings !== settingsSeed || initial.progress !== null ||
      initial.toastText !== '' || initial.toastShown || initial.toastHidden !== true || initial.toastDisplay !== 'none') {
    throw new Error(`Unexpected isolated Level 11 starting state: ${JSON.stringify(initial)}`);
  }

  const timerProbeInstalled = await evaluate(`(() => {
    const w=document.querySelector('#game')?.contentWindow;
    if(!w || w.__hexpourToastTimerProbe) return false;
    const originalSetTimeout=w.setTimeout.bind(w);
    const originalClearTimeout=w.clearTimeout.bind(w);
    const probe={scheduled:[],cancelled:[],fired:[]};
    w.__hexpourToastTimerProbe=probe;
    w.setTimeout=function(callback,delay,...args){
      if(delay!==1600) return originalSetTimeout(callback,delay,...args);
      let id;
      id=originalSetTimeout(()=>{probe.fired.push(id);callback(...args);},delay);
      probe.scheduled.push(id);
      return id;
    };
    w.clearTimeout=function(id){
      if(probe.scheduled.includes(id) && !probe.cancelled.includes(id)) probe.cancelled.push(id);
      return originalClearTimeout(id);
    };
    return true;
  })()`);
  if (!timerProbeInstalled) throw new Error('Could not install the isolated toast-timer probe.');

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

  const afterBlocked = await blockedAttempt();
  if (afterBlocked.sourcePressed !== 'true' || !afterBlocked.sourceSelected ||
      !afterBlocked.holeVisual || !afterBlocked.legalVisual ||
      afterBlocked.selectionText !== selected.selectionText || afterBlocked.activeCell < 0 ||
      afterBlocked.toastText !== 'Blocked cell' || afterBlocked.toastRole !== 'status' ||
      afterBlocked.toastLive !== 'polite' || afterBlocked.toastAtomic !== 'true' ||
      !afterBlocked.toastShown || afterBlocked.toastHidden !== false ||
      afterBlocked.toastTimers?.scheduled !== 1 || afterBlocked.toastTimers?.cancelled !== 0 ||
      afterBlocked.toastTimers?.fired !== 0 || afterBlocked.toastTimers?.pending !== 1) {
    throw new Error(`Blocked attempt lost selection or accessible/visual feedback: ${JSON.stringify(afterBlocked)}`);
  }
  if (afterBlocked.board.some((cell, index) => JSON.stringify(cell) !== JSON.stringify(initial.board[index])) ||
      afterBlocked.moveStatus !== 'Pours: 0' || afterBlocked.undoDisabled !== true ||
      afterBlocked.settings !== initial.settings || afterBlocked.progress !== initial.progress ||
      afterBlocked.canvasHash !== selected.canvasHash) {
    throw new Error(`Blocked attempt changed the board, Undo, saved progress, settings, or canvas selection: ${JSON.stringify(afterBlocked)}`);
  }

  const afterRepeatedBlocked = await blockedAttempt();
  if (afterRepeatedBlocked.toastText !== 'Blocked cell' || !afterRepeatedBlocked.toastShown ||
      afterRepeatedBlocked.toastHidden !== false || afterRepeatedBlocked.toastRole !== 'status' ||
      afterRepeatedBlocked.toastLive !== 'polite' || afterRepeatedBlocked.toastAtomic !== 'true' ||
      afterRepeatedBlocked.toastTimers?.scheduled !== 2 || afterRepeatedBlocked.toastTimers?.cancelled !== 1 ||
      afterRepeatedBlocked.toastTimers?.fired !== 0 || afterRepeatedBlocked.toastTimers?.pending !== 1 ||
      afterRepeatedBlocked.moveStatus !== 'Pours: 0' || afterRepeatedBlocked.undoDisabled !== true ||
      JSON.stringify(afterRepeatedBlocked.board) !== JSON.stringify(initial.board) ||
      afterRepeatedBlocked.progress !== initial.progress || afterRepeatedBlocked.activeCell < 0) {
    throw new Error(`Repeated blocked feedback did not replace the previous single timer cleanly: ${JSON.stringify(afterRepeatedBlocked)}`);
  }

  await pressEnter();
  const afterDeselect = await evaluate(stateExpression);
  if (afterDeselect.toastText !== '' || afterDeselect.toastShown || afterDeselect.toastHidden !== true ||
      afterDeselect.toastTimers?.scheduled !== 2 || afterDeselect.toastTimers?.cancelled !== 2 ||
      afterDeselect.toastTimers?.fired !== 0 || afterDeselect.toastTimers?.pending !== 0 ||
      afterDeselect.sourceSelected || afterDeselect.selectionText !== '' || afterDeselect.activeCell < 0 ||
      afterDeselect.moveStatus !== 'Pours: 0' || afterDeselect.undoDisabled !== true ||
      JSON.stringify(afterDeselect.board) !== JSON.stringify(initial.board) ||
      afterDeselect.progress !== initial.progress || afterDeselect.settings !== initial.settings) {
    throw new Error(`Source deselection did not immediately clear stale feedback while preserving the board, save, and focus: ${JSON.stringify(afterDeselect)}`);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 2100));
  const afterCancelledToastTimers = await evaluate(stateExpression);
  if (afterCancelledToastTimers.toastText !== '' || !afterCancelledToastTimers.toastHidden ||
      afterCancelledToastTimers.toastTimers?.fired !== 0 || afterCancelledToastTimers.toastTimers?.pending !== 0 ||
      JSON.stringify(afterCancelledToastTimers.board) !== JSON.stringify(initial.board) ||
      afterCancelledToastTimers.progress !== initial.progress || afterCancelledToastTimers.activeCell < 0) {
    throw new Error(`A replaced/cleared toast timer fired or changed game state after two seconds: ${JSON.stringify(afterCancelledToastTimers)}`);
  }

  const selectedAgain = await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const b=[...d.querySelectorAll('#play.screen.active .cell-control')].find(x=>x.getAttribute('aria-label')?.startsWith('Hex cell q 0, r 0:')); b.focus(); return d.activeElement===b; })()`);
  if (!selectedAgain) throw new Error('Could not refocus the source after Escape cleared the blocked toast.');
  await pressEnter();
  await waitFor(`(() => { const d=document.querySelector('#game')?.contentDocument; return [...d?.querySelectorAll('#play.screen.active .cell-control')||[]].find(x=>x.getAttribute('aria-label')?.startsWith('Hex cell q 0, r 0:'))?.getAttribute('aria-pressed')==='true'; })()`, 'source reselection after Escape');

  const focusedLegalDestination = await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const b=[...d.querySelectorAll('#play.screen.active .cell-control')].find(x=>x.getAttribute('aria-label')?.startsWith('Hex cell q 1, r -1:')); if(!b||!b.classList.contains('legal-target'))return false; b.focus(); return d.activeElement===b; })()`);
  if (!focusedLegalDestination) throw new Error('The legal destination was not available while the original source remained selected.');
  await pressEnter();
  await waitFor(`(() => document.querySelector('#game')?.contentDocument?.querySelector('#play.screen.active .move-status')?.textContent==='Pours: 1')()`, 'the legal adjacent pour');
  const afterLegal = await evaluate(stateExpression);
  const savedProgress = afterLegal.progress ? JSON.parse(afterLegal.progress) : null;
  if (afterLegal.undoDisabled !== false || afterLegal.settings !== initial.settings ||
      savedProgress?.levelId !== 11 || savedProgress?.moveCount !== 1 ||
      afterLegal.sourceLabel?.includes('blue') || !afterLegal.legalLabel?.includes('blue') ||
      afterLegal.toastText !== '' || afterLegal.toastShown || afterLegal.toastHidden !== true ||
      afterLegal.toastTimers?.scheduled !== 2 || afterLegal.toastTimers?.cancelled !== 2 ||
      afterLegal.toastTimers?.fired !== 0 || afterLegal.toastTimers?.pending !== 0 ||
      afterLegal.moveStatus !== 'Pours: 1' || afterLegal.moveStatusLive !== 'polite' ||
      afterLegal.moveStatusAtomic !== 'true' ||
      !afterLegal.activeCellLabel?.startsWith('Hex cell q 1, r -1:')) {
    throw new Error(`Legal pour/save behavior failed: ${JSON.stringify(afterLegal)}`);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 2100));
  const afterLegalOrphanTimerWindow = await evaluate(stateExpression);
  if (afterLegalOrphanTimerWindow.toastText !== '' || !afterLegalOrphanTimerWindow.toastHidden ||
      afterLegalOrphanTimerWindow.toastTimers?.fired !== 0 || afterLegalOrphanTimerWindow.toastTimers?.pending !== 0 ||
      afterLegalOrphanTimerWindow.moveStatus !== 'Pours: 1' ||
      afterLegalOrphanTimerWindow.progress !== afterLegal.progress ||
      JSON.stringify(afterLegalOrphanTimerWindow.board) !== JSON.stringify(afterLegal.board) ||
      afterLegalOrphanTimerWindow.activeCell < 0 || afterLegalOrphanTimerWindow.settings !== initial.settings) {
    throw new Error(`A stale toast timer fired after a legal pour or changed game state: ${JSON.stringify(afterLegalOrphanTimerWindow)}`);
  }

  const selectedBeforeBlockedUndo = await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const b=[...d.querySelectorAll('#play.screen.active .cell-control')].find(x=>x.getAttribute('aria-label')?.startsWith('Hex cell q 0, r 0:')); b?.focus(); return d.activeElement===b; })()`);
  if (!selectedBeforeBlockedUndo) throw new Error('Could not focus the source for invalid-to-Undo coverage.');
  await pressEnter();
  await waitFor(`(() => { const d=document.querySelector('#game')?.contentDocument; const b=[...d?.querySelectorAll('#play.screen.active .cell-control')||[]].find(x=>x.getAttribute('aria-label')?.startsWith('Hex cell q 0, r 0:')); return b?.getAttribute('aria-pressed')==='true'; })()`, 'source selection before invalid-to-Undo');
  const beforeUndoBlocked = await blockedAttempt();
  if (beforeUndoBlocked.toastText !== 'Blocked cell' || beforeUndoBlocked.toastRole !== 'status' ||
      beforeUndoBlocked.toastLive !== 'polite' || beforeUndoBlocked.toastAtomic !== 'true' ||
      beforeUndoBlocked.toastTimers?.scheduled !== 3 || beforeUndoBlocked.toastTimers?.cancelled !== 2 ||
      beforeUndoBlocked.toastTimers?.fired !== 0 || beforeUndoBlocked.toastTimers?.pending !== 1 ||
      beforeUndoBlocked.undoDisabled !== false || beforeUndoBlocked.moveStatus !== 'Pours: 1' ||
      beforeUndoBlocked.progress !== afterLegal.progress ||
      JSON.stringify(beforeUndoBlocked.board) !== JSON.stringify(afterLegal.board) ||
      !beforeUndoBlocked.sourceSelected || beforeUndoBlocked.activeCell < 0 ||
      beforeUndoBlocked.settings !== initial.settings) {
    throw new Error(`Invalid move changed the prior legal move, Undo history, save, or focus: ${JSON.stringify(beforeUndoBlocked)}`);
  }
  const focusedUndo = await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const b=[...d.querySelectorAll('#play.screen.active .toolbar button')].find(x=>x.textContent.trim()==='Undo'); b?.focus(); return d.activeElement===b; })()`);
  if (!focusedUndo) throw new Error('Could not focus Undo after a legal pour.');
  await pressEnter();
  const immediatelyAfterUndo = await evaluate(stateExpression);
  if (immediatelyAfterUndo.toastText !== '' || immediatelyAfterUndo.toastShown ||
      immediatelyAfterUndo.toastHidden !== true || immediatelyAfterUndo.toastTimers?.scheduled !== 3 ||
      immediatelyAfterUndo.toastTimers?.cancelled !== 3 || immediatelyAfterUndo.toastTimers?.fired !== 0 ||
      immediatelyAfterUndo.toastTimers?.pending !== 0) {
    throw new Error(`Undo did not immediately empty/hide the toast and cancel its timer: ${JSON.stringify(immediatelyAfterUndo)}`);
  }
  await waitFor(`(() => { const d=document.querySelector('#game')?.contentDocument; const b=[...d.querySelectorAll('#play.screen.active .cell-control')].find(x=>x.getAttribute('aria-label')?.startsWith('Hex cell q 0, r 0:')); return d?.querySelector('#play.screen.active .move-status')?.textContent==='Pours: 0' && d.defaultView.localStorage.getItem('hexpour:in-progress')===null && b?.getAttribute('aria-label')?.includes('red, red, blue'); })()`, 'Undo restoring the source stack and clearing the in-progress snapshot');
  const afterUndo = await evaluate(stateExpression);
  if (afterUndo.undoDisabled !== true || afterUndo.settings !== initial.settings || afterUndo.progress !== null ||
      afterUndo.toastText !== '' || afterUndo.toastShown || afterUndo.toastHidden !== true ||
      afterUndo.toastTimers?.fired !== 0 || afterUndo.toastTimers?.pending !== 0 ||
      JSON.stringify(afterUndo.board) !== JSON.stringify(initial.board) ||
      !afterUndo.sourceLabel?.includes('red, red, blue') || !afterUndo.legalLabel?.includes('empty')) {
    throw new Error(`Undo did not restore the original board/save/settings: ${JSON.stringify(afterUndo)}`);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 2100));
  const afterUndoOrphanTimerWindow = await evaluate(stateExpression);
  if (afterUndoOrphanTimerWindow.toastText !== '' || !afterUndoOrphanTimerWindow.toastHidden ||
      afterUndoOrphanTimerWindow.toastTimers?.fired !== 0 || afterUndoOrphanTimerWindow.toastTimers?.pending !== 0 ||
      JSON.stringify(afterUndoOrphanTimerWindow.board) !== JSON.stringify(initial.board) ||
      afterUndoOrphanTimerWindow.progress !== null || afterUndoOrphanTimerWindow.settings !== initial.settings) {
    throw new Error(`An invalid-to-Undo toast timer fired or changed state after two seconds: ${JSON.stringify(afterUndoOrphanTimerWindow)}`);
  }

  const afterTimeoutTrigger = await blockedAttempt();
  if (afterTimeoutTrigger.toastText !== 'Blocked cell' || !afterTimeoutTrigger.toastShown ||
      afterTimeoutTrigger.toastHidden !== false || afterTimeoutTrigger.toastTimers?.scheduled !== 4 ||
      afterTimeoutTrigger.toastTimers?.cancelled !== 3 || afterTimeoutTrigger.toastTimers?.pending !== 1 ||
      JSON.stringify(afterTimeoutTrigger.board) !== JSON.stringify(initial.board) ||
      afterTimeoutTrigger.progress !== null || afterTimeoutTrigger.settings !== initial.settings) {
    throw new Error(`Could not establish an independent natural toast-timeout case: ${JSON.stringify(afterTimeoutTrigger)}`);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 1700));
  const afterTimeout = await evaluate(stateExpression);
  if (afterTimeout.toastText !== 'Blocked cell' || afterTimeout.toastShown || afterTimeout.toastHidden !== true ||
      afterTimeout.toastDisplay !== 'none' ||
      afterTimeout.toastRole !== 'status' || afterTimeout.toastLive !== 'polite' ||
      afterTimeout.toastTimers?.scheduled !== 4 || afterTimeout.toastTimers?.cancelled !== 3 ||
      afterTimeout.toastTimers?.fired !== 1 || afterTimeout.toastTimers?.pending !== 0 ||
      afterTimeout.undoDisabled !== true || afterTimeout.moveStatus !== 'Pours: 0' ||
      JSON.stringify(afterTimeout.board) !== JSON.stringify(initial.board) ||
      afterTimeout.progress !== null || afterTimeout.settings !== initial.settings) {
    throw new Error(`The 1.6-second toast timeout did not hide the live region without game-state changes: ${JSON.stringify(afterTimeout)}`);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 600));
  const afterNaturalToastTwoSeconds = await evaluate(stateExpression);
  if (afterNaturalToastTwoSeconds.toastText !== 'Blocked cell' || !afterNaturalToastTwoSeconds.toastHidden ||
      afterNaturalToastTwoSeconds.toastDisplay !== 'none' ||
      afterNaturalToastTwoSeconds.toastTimers?.fired !== 1 || afterNaturalToastTwoSeconds.toastTimers?.pending !== 0 ||
      JSON.stringify(afterNaturalToastTwoSeconds.board) !== JSON.stringify(initial.board) ||
      afterNaturalToastTwoSeconds.progress !== null || afterNaturalToastTwoSeconds.settings !== initial.settings) {
    throw new Error(`The expired toast resurfaced or changed game state after two seconds: ${JSON.stringify(afterNaturalToastTwoSeconds)}`);
  }

  await blockedAttempt();
  const sourceForSelectionClear = await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const b=[...d.querySelectorAll('#play.screen.active .cell-control')].find(x=>x.getAttribute('aria-label')?.startsWith('Hex cell q 0, r 0:')); b?.focus(); return d.activeElement===b; })()`);
  if (!sourceForSelectionClear) throw new Error('Could not focus a source for valid-selection toast cleanup.');
  await pressEnter();
  const afterValidSelection = await evaluate(stateExpression);
  if (afterValidSelection.toastText !== '' || afterValidSelection.toastShown ||
      afterValidSelection.toastHidden !== true || afterValidSelection.toastTimers?.scheduled !== 5 ||
      afterValidSelection.toastTimers?.cancelled !== 4 || afterValidSelection.toastTimers?.fired !== 1 ||
      afterValidSelection.toastTimers?.pending !== 0 || !afterValidSelection.sourceSelected ||
      afterValidSelection.activeCell < 0 || afterValidSelection.undoDisabled !== true ||
      JSON.stringify(afterValidSelection.board) !== JSON.stringify(initial.board) ||
      afterValidSelection.progress !== null || afterValidSelection.settings !== initial.settings) {
    throw new Error(`Valid selection did not clear stale toast feedback or changed game state: ${JSON.stringify(afterValidSelection)}`);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 2100));
  const afterSelectionOrphanTimer = await evaluate(stateExpression);
  if (afterSelectionOrphanTimer.toastText !== '' || !afterSelectionOrphanTimer.toastHidden ||
      afterSelectionOrphanTimer.toastTimers?.fired !== 1 || afterSelectionOrphanTimer.toastTimers?.pending !== 0 ||
      !afterSelectionOrphanTimer.sourceSelected || afterSelectionOrphanTimer.activeCell < 0 ||
      JSON.stringify(afterSelectionOrphanTimer.board) !== JSON.stringify(initial.board) ||
      afterSelectionOrphanTimer.progress !== null) {
    throw new Error(`A selection-cleared timer fired or disturbed focus/state: ${JSON.stringify(afterSelectionOrphanTimer)}`);
  }

  const legalAfterUndo = await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const b=[...d.querySelectorAll('#play.screen.active .cell-control')].find(x=>x.getAttribute('aria-label')?.startsWith('Hex cell q 1, r -1:')); if(!b||!b.classList.contains('legal-target'))return false; b.focus(); return d.activeElement===b; })()`);
  if (!legalAfterUndo) throw new Error('No legal destination was available for Restart lifecycle coverage.');
  await pressEnter();
  await waitFor(`(() => document.querySelector('#game')?.contentDocument?.querySelector('#play.screen.active .move-status')?.textContent==='Pours: 1')()`, 'legal pour before Restart lifecycle test');
  const beforeRestartToast = await blockedAttempt();
  const focusedRestart = await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const b=[...d.querySelectorAll('#play.screen.active .toolbar button')].find(x=>x.textContent.trim()==='Restart'); b?.focus(); return d.activeElement===b; })()`);
  if (!focusedRestart || beforeRestartToast.toastText !== 'Blocked cell' || beforeRestartToast.toastTimers?.pending !== 1) {
    throw new Error('Could not establish a visible stale toast before Restart.');
  }
  const invokedRestart = await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const b=[...d.querySelectorAll('#play.screen.active .toolbar button')].find(x=>x.textContent.trim()==='Restart'); if(d.activeElement!==b)return false; b.click(); return true; })()`);
  if (!invokedRestart) throw new Error('The focused Restart action could not be invoked.');
  await waitFor(`(() => !!document.querySelector('#game')?.contentDocument?.querySelector('.restart-modal[role="dialog"]'))()`, 'Restart confirmation dialog');
  const duringRestartConfirmation = await evaluate(stateExpression);
  if (duringRestartConfirmation.toastText !== '' || duringRestartConfirmation.toastShown ||
      duringRestartConfirmation.toastHidden !== true || duringRestartConfirmation.toastTimers?.scheduled !== 6 ||
      duringRestartConfirmation.toastTimers?.cancelled !== 5 || duringRestartConfirmation.toastTimers?.fired !== 1 ||
      duringRestartConfirmation.toastTimers?.pending !== 0 || duringRestartConfirmation.undoDisabled !== false ||
      duringRestartConfirmation.moveStatus !== 'Pours: 1' ||
      JSON.stringify(duringRestartConfirmation.board) !== JSON.stringify(beforeRestartToast.board) ||
      duringRestartConfirmation.progress !== beforeRestartToast.progress || duringRestartConfirmation.settings !== initial.settings) {
    throw new Error(`Restart confirmation did not clear toast immediately while preserving the saved run: ${JSON.stringify(duringRestartConfirmation)}`);
  }
  const clickedConfirmRestart = await evaluate(`(() => { const d=document.querySelector('#game').contentDocument; const b=[...d.querySelectorAll('.restart-modal button')].find(x=>x.textContent.trim()==='Restart level'); b?.click(); return !!b; })()`);
  if (!clickedConfirmRestart) throw new Error('Restart level confirmation action was not present.');
  await waitFor(`(() => { const d=document.querySelector('#game')?.contentDocument; return d?.querySelector('#play.screen.active .move-status')?.textContent==='Pours: 0' && d.defaultView.localStorage.getItem('hexpour:in-progress')===null; })()`, 'confirmed Restart clearing the saved run');
  const afterRestart = await evaluate(stateExpression);
  if (afterRestart.toastText !== '' || afterRestart.toastShown || afterRestart.toastHidden !== true ||
      afterRestart.toastTimers?.fired !== 1 || afterRestart.toastTimers?.pending !== 0 ||
      afterRestart.undoDisabled !== true || afterRestart.progress !== null ||
      JSON.stringify(afterRestart.board) !== JSON.stringify(initial.board) ||
      afterRestart.settings !== initial.settings || afterRestart.moveStatus !== 'Pours: 0') {
    throw new Error(`Confirmed Restart left stale toast state or failed to restore a fresh board: ${JSON.stringify(afterRestart)}`);
  }

  console.log('PASS invalid feedback uses a polite status region and preserves selection, board, focus, save, and Undo.');
  console.log('PASS repeated blocked feedback keeps one authoritative toast timer; source deselection and legal selection clear stale feedback immediately.');
  console.log('PASS legal pour clears/hides stale feedback and updates the existing polite pour-count region without focus/save changes; no old timer fires after two seconds.');
  console.log('PASS invalid-to-Undo clears the live region immediately, restores the exact board/save, and cancels its timer without later firing.');
  console.log('PASS the 1.6-second timeout hides the polite region from the visual/accessibility tree, preserves one-time cue text in the hidden node, and leaves game state unchanged.');
  console.log('PASS Restart clears stale feedback immediately and confirmed reset returns to a clean board.');
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

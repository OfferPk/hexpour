import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';

const repoRoot = process.cwd();
const publicTestUrl = process.env.HEXPOUR_TEST_URL;
if (publicTestUrl) {
  const parsed = new URL(publicTestUrl);
  if (parsed.origin !== 'https://offerpk.github.io' || parsed.pathname !== '/hexpour/') {
    throw new Error('HEXPOUR_TEST_URL is restricted to the canonical Hexpour Pages URL.');
  }
}
const chromiumPath = process.env.CHROMIUM_BIN || [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
].find((candidate) => existsSync(candidate));
if (!chromiumPath) throw new Error('Chromium was not found.');

const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-touch-pour-'));
if ((await readdir(profileDirectory)).length !== 0) {
  throw new Error('The disposable Chromium profile must be empty before launch.');
}

let server;
let browser;
let socket;
let targetUrl;
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
  const diagnostic = await evaluate('({url:location.href,title:document.title,body:document.body?.innerText?.slice(0,220)})');
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}

async function tap(point) {
  await command('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ id: 1, x: point.x, y: point.y, radiusX: 2, radiusY: 2, force: 1 }],
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 70));
  await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

try {
  if (publicTestUrl) {
    targetUrl = publicTestUrl;
  } else {
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
  if (!activePortContents) throw new Error('Chromium did not create its DevTools endpoint.');
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
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
  });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await command('Page.navigate', { url: targetUrl });
  await waitFor(`document.readyState==='complete'&&!!document.querySelector('#app')`, 'the HexPour app shell');

  const initialStorage = await evaluate(`({
    local:[...Array(localStorage.length)].map((_,i)=>localStorage.key(i)).sort(),
    session:[...Array(sessionStorage.length)].map((_,i)=>sessionStorage.key(i)).sort()
  })`);
  if (initialStorage.local.length !== 0 || initialStorage.session.length !== 0) {
    throw new Error(`Fresh origin storage was not empty before synthetic setup: ${JSON.stringify(initialStorage)}`);
  }

  const settings = JSON.stringify({ unlocked: 2, adsRemoved: false, mute: true });
  await evaluate(`(() => {
    localStorage.setItem('hexpour_v1', ${JSON.stringify(settings)});
    localStorage.setItem('hexpour:howto', '1');
    sessionStorage.setItem('hexpour:a2hs', '1');
    return true;
  })()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`!!document.querySelector('#home.screen.active button')&&!document.querySelector('.overlay.open')`, 'Home after isolated setup');
  const started = await evaluate(`(() => {
    const button=[...document.querySelectorAll('#home.screen.active .home-actions button')]
      .find(item=>item.textContent.trim()==='Play');
    if(!button) return false;
    button.click();
    return true;
  })()`);
  if (!started) throw new Error('Home Play was unavailable in the isolated Level 2 setup.');
  await waitFor(`document.querySelector('#play.screen.active .topbar .title')?.textContent.trim()==='Level 2'&&!!document.querySelector('#play.screen.active canvas')`, 'Level 2 play screen');
  await evaluate('new Promise(resolveFrame=>requestAnimationFrame(()=>requestAnimationFrame(resolveFrame)))');

  const initial = await evaluate(`(() => {
    const play=document.querySelector('#play.screen.active');
    const canvas=play?.querySelector('.play-canvas-wrap canvas');
    const controls=[...play?.querySelectorAll('.cell-control')||[]];
    if(!play||!canvas||controls.length!==3) return null;
    const axial=(q,r,size)=>({x:1.5*q*size,y:(Math.sqrt(3)/2*q+Math.sqrt(3)*r)*size});
    const coords=[{q:0,r:0},{q:1,r:0},{q:0,r:1}];
    const probe=20;
    const probes=coords.map(cell=>axial(cell.q,cell.r,probe));
    const minX=Math.min(...probes.map(p=>p.x)),maxX=Math.max(...probes.map(p=>p.x));
    const minY=Math.min(...probes.map(p=>p.y)),maxY=Math.max(...probes.map(p=>p.y));
    const bw=maxX-minX+2*probe,bh=maxY-minY+2*probe;
    const cw=canvas.clientWidth,ch=canvas.clientHeight;
    const size=Math.min((cw-32)/(bw/probe),(ch-32)/(bh/probe));
    const pixels=coords.map(cell=>({cell,...axial(cell.q,cell.r,size)}));
    const centroidX=pixels.reduce((sum,p)=>sum+p.x,0)/pixels.length;
    const centroidY=pixels.reduce((sum,p)=>sum+p.y,0)/pixels.length;
    const originX=cw/2-centroidX,originY=ch/2-centroidY;
    const rect=canvas.getBoundingClientRect();
    const point=(q,r)=>{const cell=pixels.find(p=>p.cell.q===q&&p.cell.r===r);return cell?{x:rect.left+originX+cell.x,y:rect.top+originY+cell.y}:null;};
    const normalize=label=>label?.replace(' Selected source. Press again to deselect.','')
      .replace(' Legal destination from selected source. Press to pour.','')
      .replace(' Blocked adjacent cell. Cannot be used as a destination.','');
    return {
      title:play.querySelector('.topbar .title')?.textContent.trim(),
      points:{source:point(0,0),destination:point(0,1)},
      labels:controls.map(button=>normalize(button.getAttribute('aria-label'))),
      moveStatus:play.querySelector('.move-status')?.textContent,
      undoDisabled:[...play.querySelectorAll('.toolbar button')].find(b=>b.textContent.trim()==='Undo')?.disabled,
      focusIsSummary:document.activeElement===play.querySelector('.accessible-board > summary'),
      settings:localStorage.getItem('hexpour_v1'),
      progress:localStorage.getItem('hexpour:in-progress'),
      completion:localStorage.getItem('hexpour:completed-levels'),
      touchAction:getComputedStyle(canvas).touchAction,
    };
  })()`);
  if (!initial || initial.title !== 'Level 2' || initial.moveStatus !== 'Pours: 0' ||
      initial.undoDisabled !== true || initial.settings !== settings || initial.progress !== null ||
      initial.completion !== null || initial.touchAction !== 'none' || !initial.focusIsSummary ||
      !initial.points.source || !initial.points.destination ||
      !initial.labels[0]?.includes('bottom to top red, green, green') ||
      !initial.labels[2]?.includes('empty; 0 of 3 slots filled')) {
    throw new Error(`Unexpected isolated Level 2 starting state: ${JSON.stringify(initial)}`);
  }

  const listenerInstalled = await evaluate(`(() => {
    const canvas=document.querySelector('#play.screen.active canvas');
    if(!canvas) return false;
    window.__hexTouchRegression={events:[],clicks:[]};
    canvas.addEventListener('pointerup',event=>window.__hexTouchRegression.events.push({
      pointerType:event.pointerType,isPrimary:event.isPrimary,target:event.target?.tagName
    }),true);
    canvas.addEventListener('click',event=>window.__hexTouchRegression.clicks.push({
      pointerType:event.pointerType??null,target:event.target?.tagName
    }),true);
    return true;
  })()`);
  if (!listenerInstalled) throw new Error('Could not observe pointer events on the play canvas.');

  await tap(initial.points.source);
  await waitFor(`document.querySelector('#play.screen.active .screen-reader-status')?.textContent.includes('Selected source: Hex cell q 0, r 0.')`, 'touch selection of the source cell');
  const afterSource = await evaluate(`(() => {
    const play=document.querySelector('#play.screen.active');
    const controls=[...play.querySelectorAll('.cell-control')];
    const normalize=label=>label?.replace(' Selected source. Press again to deselect.','')
      .replace(' Legal destination from selected source. Press to pour.','')
      .replace(' Blocked adjacent cell. Cannot be used as a destination.','');
    return {
      events:window.__hexTouchRegression?.events||[],
      clicks:window.__hexTouchRegression?.clicks||[],
      selected:controls.some(b=>b.getAttribute('aria-pressed')==='true'),
      labels:controls.map(b=>normalize(b.getAttribute('aria-label'))),
      selection:play.querySelector('.screen-reader-status')?.textContent,
      moveStatus:play.querySelector('.move-status')?.textContent,
      undoDisabled:[...play.querySelectorAll('.toolbar button')].find(b=>b.textContent.trim()==='Undo')?.disabled,
      progress:localStorage.getItem('hexpour:in-progress'),
      settings:localStorage.getItem('hexpour_v1'),
      focusIsSummary:document.activeElement===play.querySelector('.accessible-board > summary'),
    };
  })()`);
  if (!afterSource.selected || afterSource.moveStatus !== 'Pours: 0' || afterSource.undoDisabled !== true ||
      afterSource.progress !== null || afterSource.settings !== settings || !afterSource.focusIsSummary ||
      JSON.stringify(afterSource.labels) !== JSON.stringify(initial.labels) ||
      !afterSource.selection?.includes('Selected source: Hex cell q 0, r 0.') ||
      afterSource.events.length !== 1 || afterSource.events[0].pointerType !== 'touch' ||
      afterSource.events[0].target !== 'CANVAS' || afterSource.clicks.length !== 1 ||
      afterSource.clicks[0].pointerType !== 'touch' || afterSource.clicks[0].target !== 'CANVAS') {
    throw new Error(`Touch source selection lost board focus or changed unrelated state: ${JSON.stringify(afterSource)}`);
  }

  await tap(initial.points.destination);
  await waitFor(`document.querySelector('#play.screen.active .move-status')?.textContent==='Pours: 1'&&localStorage.getItem('hexpour:in-progress')!==null`, 'the legal touch pour and its saved run');
  const afterPour = await evaluate(`(() => {
    const play=document.querySelector('#play.screen.active');
    const controls=[...play.querySelectorAll('.cell-control')];
    const saved=JSON.parse(localStorage.getItem('hexpour:in-progress')||'null');
    const findCell=(q,r)=>saved?.board?.cells?.find(cell=>cell.q===q&&cell.r===r)?.stack?.join(',');
    return {
      events:window.__hexTouchRegression?.events||[],
      clicks:window.__hexTouchRegression?.clicks||[],
      level:play.querySelector('.topbar .title')?.textContent.trim(),
      moveStatus:play.querySelector('.move-status')?.textContent,
      undoDisabled:[...play.querySelectorAll('.toolbar button')].find(b=>b.textContent.trim()==='Undo')?.disabled,
      labels:controls.map(b=>b.getAttribute('aria-label')),
      selection:play.querySelector('.screen-reader-status')?.textContent,
      selected:controls.some(b=>b.getAttribute('aria-pressed')==='true'),
      saved:saved?{version:saved.version,levelId:saved.levelId,moveCount:saved.moveCount,freeHintUsed:saved.freeHintUsed,undoCount:saved.undoStack?.length,cells:[findCell(0,0),findCell(1,0),findCell(0,1)]}:null,
      settings:localStorage.getItem('hexpour_v1'),
      completion:localStorage.getItem('hexpour:completed-levels'),
      session:[...Array(sessionStorage.length)].map((_,i)=>[sessionStorage.key(i),sessionStorage.getItem(sessionStorage.key(i))]).sort((a,b)=>a[0].localeCompare(b[0])),
      focusIsSummary:document.activeElement===play.querySelector('.accessible-board > summary'),
    };
  })()`);
  if (afterPour.level !== 'Level 2' || afterPour.moveStatus !== 'Pours: 1' || afterPour.undoDisabled !== false ||
      afterPour.selected || afterPour.selection !== '' || !afterPour.focusIsSummary ||
      afterPour.settings !== settings || afterPour.completion !== null ||
      JSON.stringify(afterPour.session) !== JSON.stringify([['hexpour:a2hs', '1']]) ||
      afterPour.events.length !== 2 || afterPour.events.some(event=>event.pointerType!=='touch'||event.target!=='CANVAS') ||
      afterPour.clicks.length !== 2 || afterPour.clicks.some(event=>event.pointerType!=='touch'||event.target!=='CANVAS') ||
      afterPour.saved?.version !== 1 || afterPour.saved.levelId !== 2 || afterPour.saved.moveCount !== 1 ||
      afterPour.saved.freeHintUsed !== false || afterPour.saved.undoCount !== 1 ||
      JSON.stringify(afterPour.saved.cells) !== JSON.stringify(['R','G,R','G,G']) ||
      !afterPour.labels[0]?.includes('bottom to top red; 1 of 3 slots filled') ||
      !afterPour.labels[2]?.includes('bottom to top green, green; 2 of 3 slots filled')) {
    throw new Error(`Touch pour failed focus, board, Undo, save, settings, or unlock invariants: ${JSON.stringify(afterPour)}`);
  }

  console.log(JSON.stringify({
    status: 'PASS',
    interaction: 'Touch source select and legal adjacent pour on Level 2',
    originStorageWasEmptyBeforeSyntheticSetup: initialStorage.local.length===0&&initialStorage.session.length===0,
    pointerType: afterPour.events.map(event=>event.pointerType),
    moveStatus: afterPour.moveStatus,
    undoEnabled: !afterPour.undoDisabled,
    savedRun: afterPour.saved,
    settingsAndUnlocksPreserved: afterPour.settings===settings&&afterPour.completion===null,
    focusRestoredToBoardControls: afterSource.focusIsSummary&&afterPour.focusIsSummary,
    spokenScreenReaderOutput: 'not tested; this is a browser DOM/focus regression only',
  }, null, 2));
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
} finally {
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveClose) => browser.once('close', resolveClose)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 1500)),
    ]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  }
  if (server) await server.close();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  await rm(profileDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

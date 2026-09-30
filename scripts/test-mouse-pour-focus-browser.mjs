import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = process.cwd();
const require = createRequire(resolve(repoRoot, 'package.json'));
const { createServer } = require('vite');
const chromiumPath = process.env.CHROMIUM_BIN || [
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome',
].find((candidate) => existsSync(candidate));
if (!chromiumPath) throw new Error('Chromium was not found.');

const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-mouse-pour-'));
if ((await readdir(profileDirectory)).length !== 0) throw new Error('Disposable profile directory was not empty.');
let server;
let browser;
let socket;
let nextId = 0;
const pending = new Map();
const checks = [];
const check = (ok, label, details) => {
  checks.push({ label, passed: Boolean(ok), details });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`);
  if (!ok) throw new Error(`FAIL ${label}: ${JSON.stringify(details)}`);
};
const pause = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
function command(method, params = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); rejectCommand(new Error(`Timed out: ${method}`)); }, 10000);
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.result?.exception?.description || response.exceptionDetails.text);
  return response.result?.value;
}
async function waitFor(expression, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await evaluate(expression);
    if (result) return result;
    await pause(40);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(await evaluate('({url:location.href,body:document.body?.innerText?.slice(0,250)})'))}`);
}
async function clickAt(x, y) {
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function clickSelector(selector) {
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,visible:!!(r.width&&r.height&&getComputedStyle(e).visibility!=='hidden')}})()`);
  if (!point?.visible) throw new Error(`Missing/hidden setup control ${selector}: ${JSON.stringify(point)}`);
  await clickAt(point.x, point.y);
}

try {
  server = await createServer({
    configFile: resolve(repoRoot, 'vite.config.ts'), root: repoRoot, logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind to a loopback TCP address.');

  const engine = await server.ssrLoadModule('/src/game/engine.ts');
  const levels = await server.ssrLoadModule('/src/levels/index.ts');
  const hex = await server.ssrLoadModule('/src/game/hex.ts');
  const renderer = await server.ssrLoadModule('/src/render/hexBoard.ts');
  const level = levels.getLevel(3);
  const openingMove = engine.listLegalPours(engine.loadBoard(level)).find((move) => {
    const board = engine.loadBoard(level);
    engine.tryPour(board, move.from, move.to);
    return !engine.isWon(board);
  });
  if (!openingMove) throw new Error('Level 3 lacks a nonterminal legal opening move.');
  const originalBoard = engine.loadBoard(level);
  const expectedBoard = engine.cloneBoard(originalBoard);
  const moveResult = engine.tryPour(expectedBoard, openingMove.from, openingMove.to);
  if (!moveResult.ok || engine.isWon(expectedBoard)) throw new Error('Opening move fixture was not nonterminal.');
  const serializeBoard = (board) => ({
    capacity: board.capacity,
    cells: Array.from(board.cells.values(), (cell) => ({ q: cell.q, r: cell.r, blocked: cell.blocked, stack: [...cell.stack] })),
  });
  const expectedSnapshot = {
    version: 1, levelId: 3, moveCount: 1, freeHintUsed: false,
    board: serializeBoard(expectedBoard), undoStack: [serializeBoard(originalBoard)],
  };

  browser = spawn(chromiumPath, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(profileDirectory, 'DevToolsActivePort');
  let portData;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { portData = await readFile(portFile, 'utf8'); break; } catch { await pause(50); }
  }
  if (!portData) throw new Error('Chromium did not publish a DevTools port.');
  const devtoolsPort = Number(portData.trim().split(/\s+/)[0]);
  let target;
  for (let attempt = 0; attempt < 200 && !target; attempt++) {
    try { target = (await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl); } catch {}
    if (!target) await pause(50);
  }
  if (!target) throw new Error('No page target in the fresh Chromium profile.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
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
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', () => rejectOpen(new Error('DevTools WebSocket failed.')), { once: true });
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  const localUrl = `http://127.0.0.1:${address.port}/hexpour/`;
  await command('Page.navigate', { url: localUrl });
  await waitFor("document.readyState==='complete' && !!document.querySelector('#home.screen.active')", 'fresh Hexpour Home');

  const emptyStorage = await evaluate(`(()=>{const entries=s=>Object.fromEntries(Object.keys(s).sort().map(k=>[k,s.getItem(k)]));return {local:entries(localStorage),session:entries(sessionStorage)}})()`);
  check(Object.keys(emptyStorage.local).length === 0 && Object.keys(emptyStorage.session).length === 0,
    'Fresh origin localStorage and sessionStorage are empty before any synthetic setup', emptyStorage);

  const settings = JSON.stringify({ unlocked: 3, adsRemoved: false, mute: true });
  await evaluate(`(()=>{localStorage.setItem('hexpour_v1',${JSON.stringify(settings)});localStorage.setItem('hexpour:howto','1');sessionStorage.setItem('hexpour:a2hs','1')})()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor("document.readyState==='complete' && !!document.querySelector('#home.screen.active')", 'Home after synthetic setup');
  await clickSelector('#home .level-select-opener');
  await waitFor("!!document.querySelector('#levels.screen.active')", 'Level Select');
  await evaluate("document.querySelector('#levels .level-btn[aria-label=\"Level 3\"]')?.click()");
  await waitFor("!!document.querySelector('#play.screen.active .play-canvas-wrap canvas')", 'fresh Level 3 board');
  const before = await evaluate(`(()=>({screen:[...document.querySelectorAll('.screen.active')].map(x=>x.id),level:document.querySelector('#play .topbar .title')?.textContent.trim(),moveStatus:document.querySelector('#play .move-status')?.textContent,undoDisabled:[...document.querySelectorAll('#play .toolbar button')].find(b=>b.textContent.trim()==='Undo')?.disabled,progress:localStorage.getItem('hexpour:in-progress'),settings:localStorage.getItem('hexpour_v1'),completed:localStorage.getItem('hexpour:completed-levels'),session:Object.fromEntries(Object.keys(sessionStorage).sort().map(k=>[k,sessionStorage.getItem(k)])),focusIsSummary:document.activeElement===document.querySelector('#play .accessible-board > summary'),activeTag:document.activeElement?.tagName,activeId:document.activeElement?.id,activeText:(document.activeElement?.textContent||'').trim().slice(0,80),cells:[...document.querySelectorAll('#play .cell-control')].map(b=>({label:b.getAttribute('aria-label'),pressed:b.getAttribute('aria-pressed')}))}))()`);
  check(before.screen.join(',') === 'play' && before.level === 'Level 3' && before.moveStatus === 'Pours: 0' && before.undoDisabled === true && before.progress === null && before.settings === settings,
    'A fresh Level 3 starts without a saved run and with seeded settings/unlocks unchanged', { level: before.level, moveStatus: before.moveStatus, undoDisabled: before.undoDisabled, progress: before.progress, settings: before.settings, focusIsSummary: before.focusIsSummary, activeTag: before.activeTag, activeId: before.activeId, activeText: before.activeText });

  const probeInstalled = await evaluate(`(()=>{const canvas=document.querySelector('#play.screen.active canvas');if(!canvas)return false;window.__hexMouseAudit=[];canvas.addEventListener('pointerup',e=>window.__hexMouseAudit.push({type:e.type,pointerType:e.pointerType,isPrimary:e.isPrimary,target:e.target?.tagName,x:e.clientX,y:e.clientY}));canvas.addEventListener('click',e=>window.__hexMouseAudit.push({type:e.type,pointerType:e.pointerType||null,target:e.target?.tagName,x:e.clientX,y:e.clientY}));return true})()`);
  check(probeInstalled, 'Pointer/click observer attached only to the fresh Level 3 canvas');
  const rect = await evaluate(`(()=>{const r=document.querySelector('#play.screen.active canvas').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()`);
  const layout = renderer.computeLayout(originalBoard, rect.width, rect.height);
  const sourcePx = hex.axialToPixel(openingMove.from.q, openingMove.from.r, layout.size);
  const targetPx = hex.axialToPixel(openingMove.to.q, openingMove.to.r, layout.size);
  const sourcePoint = { x: rect.left + layout.originX + sourcePx.x, y: rect.top + layout.originY + sourcePx.y };
  const targetPoint = { x: rect.left + layout.originX + targetPx.x, y: rect.top + layout.originY + targetPx.y };

  await clickAt(sourcePoint.x, sourcePoint.y);
  await waitFor(`document.querySelector('#play .cell-control[aria-pressed="true"]')?.getAttribute('aria-label')?.startsWith(${JSON.stringify(`Hex cell q ${openingMove.from.q}, r ${openingMove.from.r}:`)})`, 'mouse source-cell selection');
  const afterSource = await evaluate(`(()=>({status:document.querySelector('#play .screen-reader-status')?.textContent,moveStatus:document.querySelector('#play .move-status')?.textContent,undoDisabled:[...document.querySelectorAll('#play .toolbar button')].find(b=>b.textContent.trim()==='Undo')?.disabled,progress:localStorage.getItem('hexpour:in-progress'),settings:localStorage.getItem('hexpour_v1'),pressed:[...document.querySelectorAll('#play .cell-control')].filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.getAttribute('aria-label')),events:window.__hexMouseAudit,focusIsSummary:document.activeElement===document.querySelector('#play .accessible-board > summary'),activeTag:document.activeElement?.tagName,activeId:document.activeElement?.id,activeText:(document.activeElement?.textContent||'').trim().slice(0,80)}))()`);
  check(afterSource.pressed.length === 1 && afterSource.pressed[0]?.startsWith(`Hex cell q ${openingMove.from.q}, r ${openingMove.from.r}:`) && afterSource.status?.includes(`Hex cell q ${openingMove.from.q}, r ${openingMove.from.r}.`) && afterSource.moveStatus === 'Pours: 0' && afterSource.undoDisabled === true && afterSource.progress === null && afterSource.settings === settings && afterSource.focusIsSummary,
    'First actual mouse click selects only the intended source without moving or saving, and with focus retained on the board-controls summary', { selection: afterSource.pressed, status: afterSource.status, moveStatus: afterSource.moveStatus, undoDisabled: afterSource.undoDisabled, progress: afterSource.progress, focusIsSummary: afterSource.focusIsSummary, activeTag: afterSource.activeTag, activeId: afterSource.activeId, activeText: afterSource.activeText });

  await clickAt(targetPoint.x, targetPoint.y);
  await waitFor("document.querySelector('#play.screen.active .move-status')?.textContent==='Pours: 1'", 'one legal nonterminal mouse pour');
  const afterPour = await evaluate(`(()=>({screen:[...document.querySelectorAll('.screen.active')].map(x=>x.id),moveStatus:document.querySelector('#play .move-status')?.textContent,undoDisabled:[...document.querySelectorAll('#play .toolbar button')].find(b=>b.textContent.trim()==='Undo')?.disabled,selected:[...document.querySelectorAll('#play .cell-control')].filter(b=>b.getAttribute('aria-pressed')==='true').length,progress:localStorage.getItem('hexpour:in-progress'),settings:localStorage.getItem('hexpour_v1'),completed:localStorage.getItem('hexpour:completed-levels'),session:Object.fromEntries(Object.keys(sessionStorage).sort().map(k=>[k,sessionStorage.getItem(k)])),focusIsSummary:document.activeElement===document.querySelector('#play .accessible-board > summary'),activeTag:document.activeElement?.tagName,activeId:document.activeElement?.id,activeText:(document.activeElement?.textContent||'').trim().slice(0,80),events:window.__hexMouseAudit,cells:[...document.querySelectorAll('#play .cell-control')].map(b=>({label:b.getAttribute('aria-label'),pressed:b.getAttribute('aria-pressed')}))}))()`);
  const saved = afterPour.progress ? JSON.parse(afterPour.progress) : null;
  const stableSaved = saved && { version: saved.version, levelId: saved.levelId, moveCount: saved.moveCount, freeHintUsed: saved.freeHintUsed, board: saved.board, undoStack: saved.undoStack };
  const eventRows = afterPour.events.filter((event) => event.type === 'pointerup');
  check(afterPour.screen.join(',') === 'play' && afterPour.moveStatus === 'Pours: 1' && afterPour.undoDisabled === false && afterPour.selected === 0 && afterPour.focusIsSummary,
    'Second actual mouse click completes exactly one nonterminal pour and retains focus on the board-controls summary', { screen: afterPour.screen, moveStatus: afterPour.moveStatus, undoDisabled: afterPour.undoDisabled, selected: afterPour.selected, focusIsSummary: afterPour.focusIsSummary, activeTag: afterPour.activeTag, activeId: afterPour.activeId, activeText: afterPour.activeText });
  check(JSON.stringify(stableSaved) === JSON.stringify(expectedSnapshot),
    'Saved Level 3 board and one-entry Undo snapshot match the engine-predicted result exactly', { levelId: saved?.levelId, moveCount: saved?.moveCount, freeHintUsed: saved?.freeHintUsed, boardMatchesExpected: JSON.stringify(saved?.board) === JSON.stringify(expectedSnapshot.board), undoMatchesInitial: JSON.stringify(saved?.undoStack) === JSON.stringify(expectedSnapshot.undoStack) });
  check(eventRows.length === 2 && eventRows.every((event) => event.pointerType === 'mouse' && event.isPrimary === true && event.target === 'CANVAS'),
    'Exactly two primary mouse pointerup events land on the canvas for the two-cell pour', eventRows);
  check(afterPour.settings === settings && afterPour.completed === null && JSON.stringify(afterPour.session) === JSON.stringify({ 'hexpour:a2hs': '1' }),
    'Settings, mute, unlock level, completion state, and session flag are unchanged by the pour', { settings: afterPour.settings, completed: afterPour.completed, session: afterPour.session });

  console.log(JSON.stringify({
    status: 'PASS', target: localUrl, audit: 'actual mouse-driven legal canvas pour on fresh Level 3; focus must stay on the board-controls summary',
    profile: 'new disposable Chromium profile; filesystem directory empty before launch; origin local/session storage confirmed empty before fixture; deleted at exit',
    emptyStorage, openingMove, moveResult, before: { level: before.level, moveStatus: before.moveStatus, undoDisabled: before.undoDisabled, focusIsSummary: before.focusIsSummary },
    afterSource: { moveStatus: afterSource.moveStatus, undoDisabled: afterSource.undoDisabled, selected: afterSource.pressed, focusIsSummary: afterSource.focusIsSummary },
    afterPour: { screen: afterPour.screen, moveStatus: afterPour.moveStatus, undoEnabled: !afterPour.undoDisabled, savedLevel: saved?.levelId, savedMoveCount: saved?.moveCount, undoDepth: saved?.undoStack?.length, settings: afterPour.settings, completed: afterPour.completed, focusIsSummary: afterPour.focusIsSummary, pointerEvents: eventRows },
    checks, spokenScreenReaderOutput: 'not tested; only browser DOM live-region semantics and focus target were observed',
  }, null, 2));
} finally {
  try { socket?.close(); } catch {}
  if (browser && browser.exitCode === null) {
    await new Promise((resolveClose) => {
      const timer = setTimeout(() => { try { browser.kill('SIGKILL'); } catch {} }, 2500);
      browser.once('close', () => { clearTimeout(timer); resolveClose(); });
      try { browser.kill('SIGTERM'); } catch { clearTimeout(timer); resolveClose(); }
    });
  }
  if (server) await server.close();
  await pause(200);
  await rm(profileDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}

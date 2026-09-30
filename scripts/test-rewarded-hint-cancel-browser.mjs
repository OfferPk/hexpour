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
].find(candidate => existsSync(candidate));
if (!chromiumPath) throw new Error('Chromium was not found. Install Chromium or set CHROMIUM_BIN.');
if (requestedUrl && requestedUrl !== 'https://offerpk.github.io/hexpour/') {
  throw new Error('HEXPOUR_TEST_URL is restricted to the canonical Hexpour Pages URL.');
}

const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-rewarded-hint-cancel-'));
if ((await readdir(profileDirectory)).length !== 0) {
  throw new Error('The disposable Chromium profile must be empty before launch.');
}
let server;
let browser;
let socket;
let nextCommandId = 0;
const pending = new Map();
const checks = [];

function check(condition, label, details) {
  checks.push({ label, passed: Boolean(condition), details });
  if (!condition) throw new Error(`FAIL ${label}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`);
  console.log(`PASS ${label}`);
}

function command(method, params = {}) {
  return new Promise((resolveCommand, reject) => {
    const id = ++nextCommandId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`DevTools command timed out: ${method}`));
    }, 10000);
    pending.set(id, { resolve: resolveCommand, reject, timer });
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

async function waitFor(expression, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  const diagnostic = await evaluate('({url:location.href,title:document.title,body:document.body?.innerText?.slice(0,240)})');
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}

async function pressKey(key) {
  const virtualKey = { Enter: 13, Tab: 9, Escape: 27, Space: 32 }[key];
  if (!virtualKey) throw new Error(`Unsupported keyboard key: ${key}`);
  const params = {
    key: key === 'Space' ? ' ' : key,
    code: key === 'Space' ? 'Space' : key,
    windowsVirtualKeyCode: virtualKey,
    nativeVirtualKeyCode: virtualKey,
  };
  await command('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
  if (key === 'Enter' || key === 'Space') {
    const text = key === 'Enter' ? '\r' : ' ';
    await command('Input.dispatchKeyEvent', { type: 'char', ...params, text, unmodifiedText: text });
  }
  await command('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

const pause = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
const hintSelector = "[...document.querySelectorAll('#play .toolbar button')].find(button=>button.textContent.trim().startsWith('Hint'))";

const stateExpression = `(()=>{
  const play=document.querySelector('#play.screen.active');
  const active=document.activeElement;
  const hint=${hintSelector};
  return {
    screen:play?.id,
    title:play?.querySelector('.title')?.textContent,
    board:[...play?.querySelectorAll('.cell-control')||[]].map(button=>({label:button.getAttribute('aria-label'),disabled:button.disabled,pressed:button.getAttribute('aria-pressed')})),
    selectionStatus:play?.querySelector('.screen-reader-status')?.textContent,
    moveStatus:play?.querySelector('.move-status')?.textContent,
    undoDisabled:[...play?.querySelectorAll('.toolbar button')||[]].find(button=>button.textContent.trim()==='Undo')?.disabled,
    hintText:hint?.textContent.trim(),
    focusIsHint:active===hint,
    focusTag:active?.tagName,
    settings:localStorage.getItem('hexpour_v1'),
    progress:localStorage.getItem('hexpour:in-progress'),
    completion:localStorage.getItem('hexpour:completed-levels'),
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
  if (!address || typeof address === 'string') throw new Error('Vite did not provide a loopback address.');

  const engine = await server.ssrLoadModule('/src/game/engine.ts');
  const levels = await server.ssrLoadModule('/src/levels/index.ts');
  const levelTwo = levels.getLevel(2);
  const openingMove = engine.listLegalPours(engine.loadBoard(levelTwo)).find(move => {
    const board = engine.loadBoard(levelTwo);
    engine.tryPour(board, move.from, move.to);
    return !engine.isWon(board);
  });
  if (!openingMove) throw new Error('Level 2 has no nonterminal opening pour for this regression.');

  browser = spawn(chromiumPath, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore' });

  const portFile = join(profileDirectory, 'DevToolsActivePort');
  let portFileContent;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { portFileContent = await readFile(portFile, 'utf8'); break; }
    catch { await pause(50); }
  }
  if (!portFileContent) throw new Error('Chromium did not publish a DevTools port.');
  const port = Number(portFileContent.trim().split(/\s+/)[0]);
  let target;
  for (let attempt = 0; attempt < 200 && !target; attempt++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find(page => page.type === 'page' && page.webSocketDebuggerUrl);
    } catch { /* Wait for Chromium. */ }
    if (!target) await pause(50);
  }
  if (!target) throw new Error('No fresh Chromium page target.');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message || 'DevTools command failed.'));
    else request.resolve(message.result || {});
  });
  await new Promise((resolveOpen, rejectOpen) => {
    if (socket.readyState === WebSocket.OPEN) return resolveOpen();
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', () => rejectOpen(new Error('CDP WebSocket connection failed.')), { once: true });
  });
  await command('Page.enable');
  await command('Runtime.enable');

  const localUrl = `http://127.0.0.1:${address.port}/hexpour/`;
  const targetUrl = requestedUrl || localUrl;
  await command('Page.navigate', { url: targetUrl });
  await waitFor("document.querySelector('#home.screen.active') || document.querySelector('.overlay.open [role=dialog]')", 'Hexpour initial screen');
  const initialStorage = await evaluate(`({
    local:Object.keys(localStorage).length,
    session:Object.keys(sessionStorage).length,
    localKeys:Object.keys(localStorage).sort(),
    sessionKeys:Object.keys(sessionStorage).sort(),
  })`);
  check(initialStorage.local === 0 && initialStorage.session === 0,
    'Origin localStorage and sessionStorage are empty before synthetic setup', initialStorage);

  await evaluate(`(()=>{
    localStorage.setItem('hexpour_v1',JSON.stringify({unlocked:2,adsRemoved:false,mute:true}));
    localStorage.setItem('hexpour:howto','1');
    sessionStorage.setItem('hexpour:a2hs','1');
  })()`);
  await command('Page.reload');
  await waitFor("document.querySelector('#home.screen.active')", 'Home with synthetic Level 2 unlock');
  await evaluate("document.querySelector('#home .level-select-opener')?.click()");
  await waitFor("document.querySelector('#levels.screen.active')", 'level select');
  await evaluate("[...document.querySelectorAll('#levels .level-btn')].find(button=>button.getAttribute('aria-label')==='Level 2')?.click()");
  await waitFor("document.querySelector('#play.screen.active .cell-control')", 'Level 2 board');

  await evaluate("document.querySelector('#play .accessible-board > summary')?.focus()");
  await pressKey('Space');
  await waitFor("document.querySelector('#play .accessible-board')?.open", 'keyboard-controls disclosure');
  const focusCell = async (q, r) => evaluate(`(()=>{
    const button=[...document.querySelectorAll('#play .cell-control')]
      .find(item=>item.getAttribute('aria-label')?.startsWith('Hex cell q ${q}, r ${r}:'));
    button?.focus();
    return document.activeElement===button;
  })()`);
  check(await focusCell(openingMove.from.q, openingMove.from.r), 'Focus the valid keyboard move source', openingMove.from);
  await pressKey('Enter');
  await waitFor("document.querySelector('#play .cell-control[aria-pressed=true]')", 'keyboard source selection');
  check(await focusCell(openingMove.to.q, openingMove.to.r), 'Focus the adjacent keyboard move destination', openingMove.to);
  await pressKey('Enter');
  await waitFor("document.querySelector('#play .move-status')?.textContent?.includes('1')", 'one nonterminal pour');
  check(await evaluate("document.querySelector('#play.screen.active .move-status')?.textContent==='Pours: 1'"), 'The synthetic move remains in active play');

  await evaluate(`(()=>{const hint=${hintSelector};hint?.focus()})()`);
  await pressKey('Enter');
  await pause(100);
  const afterFreeHint = await evaluate(stateExpression);
  const savedRun = afterFreeHint.progress ? JSON.parse(afterFreeHint.progress) : null;
  check(savedRun?.levelId === 2 && savedRun.moveCount === 1 && savedRun.freeHintUsed === true && afterFreeHint.undoDisabled === false,
    'A legal move and spent free Hint are saved with Undo enabled', { savedRun, undoDisabled: afterFreeHint.undoDisabled });

  await evaluate(`(()=>[...document.querySelectorAll('#play .cell-control')]
    .find(button=>button.getAttribute('aria-label')?.startsWith('Hex cell q ${openingMove.from.q}, r ${openingMove.from.r}:'))?.focus())()`);
  await pressKey('Enter');
  await waitFor(`document.querySelector('#play .cell-control[aria-pressed=true]')?.getAttribute('aria-label')?.startsWith('Hex cell q ${openingMove.from.q}, r ${openingMove.from.r}:')`, 'armed source before rewarded-Hint prompt');
  await evaluate(`(()=>{const hint=${hintSelector};hint?.focus()})()`);
  const beforeCancel = await evaluate(stateExpression);
  check(beforeCancel.focusIsHint && beforeCancel.board.some(cell => cell.pressed === 'true'),
    'The Hint opener has focus while a keyboard-selected source is armed', { focusIsHint: beforeCancel.focusIsHint, selectedCell: beforeCancel.board.find(cell => cell.pressed === 'true') });

  await pressKey('Enter');
  await waitFor("!!document.querySelector('.overlay.open [role=dialog][aria-label=" + JSON.stringify('Ad stub — Rewarded') + "]')", 'rewarded-Hint dialog');
  const prompt = await evaluate(`({
    dialogName:document.querySelector('.overlay.open [role=dialog]')?.getAttribute('aria-label'),
    focus:document.activeElement?.textContent?.trim(),
    buttons:[...document.querySelectorAll('.overlay.open button')].map(button=>button.textContent.trim()),
  })`);
  check(prompt.dialogName === 'Ad stub — Rewarded' && prompt.focus === 'Cancel' && prompt.buttons.join('|') === 'Cancel|Earn reward',
    'Keyboard opens the rewarded-Hint prompt with Cancel initially focused', prompt);
  await pressKey('Enter');
  await waitFor("!document.querySelector('.overlay.open [role=dialog]')", 'Cancel to close rewarded-Hint prompt');
  await pause(100);
  const afterCancel = await evaluate(stateExpression);
  const stable = state => ({
    screen: state.screen,
    title: state.title,
    board: state.board,
    selectionStatus: state.selectionStatus,
    moveStatus: state.moveStatus,
    undoDisabled: state.undoDisabled,
    hintText: state.hintText,
    settings: state.settings,
    progress: state.progress,
    completion: state.completion,
  });
  check(JSON.stringify(stable(afterCancel)) === JSON.stringify(stable(beforeCancel)),
    'Cancel preserves the exact board, selection, move/Undo state, spent Hint, save, settings, and unlocks',
    { before: stable(beforeCancel), after: stable(afterCancel) });
  check(afterCancel.focusIsHint,
    'Keyboard focus returns to the Hint opener after Cancel', { focusTag: afterCancel.focusTag, focusIsHint: afterCancel.focusIsHint });
  check(await evaluate("document.querySelector('.toast')?.textContent==='Hint cancelled'"),
    'The cancellation status remains correctly announced');
  check(!(await evaluate("!!document.querySelector('.overlay.open [role=dialog]')")),
    'No rewarded prompt remains open');

  console.log(JSON.stringify({
    status: 'PASS',
    target: targetUrl,
    profile: 'fresh disposable Chromium profile; empty before synthetic setup; removed after test',
    initialStorage,
    openingMove,
    prompt,
    afterCancel: {
      screen: afterCancel.screen,
      moveStatus: afterCancel.moveStatus,
      undoDisabled: afterCancel.undoDisabled,
      hintText: afterCancel.hintText,
      focusIsHint: afterCancel.focusIsHint,
      selectedCell: afterCancel.board.find(cell => cell.pressed === 'true')?.label,
      settings: afterCancel.settings,
      progress: afterCancel.progress,
      completion: afterCancel.completion,
    },
    checks,
    spokenScreenReaderOutput: 'not tested; checks cover DOM accessibility semantics and browser focus only',
  }, null, 2));
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  if (browser && browser.exitCode === null) {
    await new Promise(resolveExit => {
      const forceKill = setTimeout(() => { try { browser.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
      browser.once('close', () => { clearTimeout(forceKill); resolveExit(); });
      try { browser.kill('SIGTERM'); } catch { clearTimeout(forceKill); resolveExit(); }
    });
  }
  if (server) await server.close();
  await pause(300);
  await rm(profileDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

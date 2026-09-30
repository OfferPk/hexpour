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
if (!chromiumPath) throw new Error('Chromium was not found. Install Chromium or set CHROMIUM_BIN.');

const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-level40-terminal-'));
if ((await readdir(profileDirectory)).length !== 0) {
  throw new Error('The disposable Chromium profile must be empty before launch.');
}
let server;
let browser;
let socket;
let commandId = 0;
const pending = new Map();
const checks = [];

function check(ok, label, details) {
  checks.push({ label, ok, details });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`);
}

function command(method, params = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const id = ++commandId;
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
  const diagnostic = await evaluate('({url:location.href,title:document.title,body:document.body?.innerText?.slice(0,200)})');
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}

async function pressKey(key, shift = false) {
  const virtualKey = ({ Tab: 9, Enter: 13, Escape: 27, Space: 32 })[key];
  if (!virtualKey) throw new Error(`Unsupported test key: ${key}`);
  const params = {
    key: key === 'Space' ? ' ' : key,
    code: key === 'Space' ? 'Space' : key,
    windowsVirtualKeyCode: virtualKey,
    nativeVirtualKeyCode: virtualKey,
    modifiers: shift ? 8 : 0,
  };
  await command('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
  if (key === 'Enter' || key === 'Space') {
    const character = key === 'Enter' ? '\r' : ' ';
    await command('Input.dispatchKeyEvent', {
      type: 'char',
      ...params,
      text: character,
      unmodifiedText: character,
    });
  }
  await command('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

const focusExpression = `(() => {
  const node=document.activeElement;
  if(!node)return null;
  const style=getComputedStyle(node);
  return {
    tag:node.tagName,
    text:(node.innerText||node.textContent||'').trim().replace(/\\s+/g,' ').slice(0,100),
    label:node.getAttribute('aria-label'),
    className:typeof node.className==='string'?node.className:'',
    focusVisible:node.matches(':focus-visible'),
    outlineStyle:style.outlineStyle,
  };
})()`;
const storageExpression = `(() => {
  const read=storage=>Object.fromEntries(Array.from({length:storage.length},(_,i)=>storage.key(i))
    .filter(key=>key!==null).sort().map(key=>[key,storage.getItem(key)]));
  return {local:read(localStorage),session:read(sessionStorage)};
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
  const targetUrl = `http://127.0.0.1:${address.port}/hexpour/`;
  const level = JSON.parse(await readFile(resolve(repoRoot, 'src/levels/level-40.json'), 'utf8'));
  const initialBoard = {
    capacity: level.capacity,
    cells: level.cells.map((cell) => ({
      q: cell.q,
      r: cell.r,
      blocked: cell.blocked === true,
      stack: cell.blocked ? [] : [...(cell.stack || [])],
    })),
  };
  const stacks = new Map([
    ['-2,1',['R','R','R','R']], ['-1,2',['R','R','R','R']], ['-1,0',['R','R','R']], ['0,0',['R']],
    ['-1,1',['B','B','B','B']], ['0,-2',['B','B','B','B']],
    ['-2,2',['Y','Y','Y','Y']], ['1,-2',['Y','Y','Y','Y']],
    ['1,0',['P','P','P','P']], ['1,1',['P','P','P','P']],
    ['-1,-1',['O','O','O']], ['0,1',['O','O','O','O']],
    ['0,-1',['G','O']], ['1,-1',['G','G','G','G']], ['2,0',['G','G','G']],
  ]);
  const fixtureBoard = {
    capacity: level.capacity,
    cells: level.cells.map((cell) => ({
      q: cell.q,
      r: cell.r,
      blocked: cell.blocked === true,
      stack: cell.blocked ? [] : [...(stacks.get(`${cell.q},${cell.r}`) || [])],
    })),
  };
  const inventory = (board) => {
    const counts = {};
    for (const cell of board.cells) for (const color of cell.stack) counts[color] = (counts[color] || 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort());
  };
  if (JSON.stringify(inventory(initialBoard)) !== JSON.stringify(inventory(fixtureBoard))) {
    throw new Error('The controlled Level 40 fixture does not preserve the shipped token inventory.');
  }
  const snapshot = {
    version: 1,
    levelId: 40,
    savedAt: Date.now(),
    moveCount: 1,
    board: fixtureBoard,
    undoStack: [initialBoard],
  };

  console.log(`Testing final-level terminal flow in a fresh Chromium profile: ${targetUrl}`);
  console.log(`Profile directory empty before launch: ${(await readdir(profileDirectory)).length === 0}`);
  browser = spawn(chromiumPath, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore' });

  const portFile = join(profileDirectory, 'DevToolsActivePort');
  let portContents;
  const portDeadline = Date.now() + 10_000;
  while (Date.now() < portDeadline) {
    if (browser.exitCode !== null) throw new Error('Chromium exited before DevTools started.');
    try { portContents = await readFile(portFile, 'utf8'); break; }
    catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  if (!portContents) throw new Error('Chromium did not publish a DevTools endpoint.');
  const devToolsPort = Number(portContents.trim().split(/\s+/)[0]);
  let pageTarget;
  const targetDeadline = Date.now() + 10_000;
  while (Date.now() < targetDeadline && !pageTarget) {
    try {
      const response = await fetch(`http://127.0.0.1:${devToolsPort}/json/list`);
      pageTarget = (await response.json()).find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  if (!pageTarget) throw new Error('Could not find a page target in the disposable profile.');

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
    socket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('Could not connect to Chromium.')); }, { once: true });
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Accessibility.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 844, height: 720, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: targetUrl });
  await waitFor(`document.readyState==='complete'&&!!document.querySelector('#home.screen.active')`, 'fresh Home screen');
  const initialStorage = await evaluate(storageExpression);
  check(Object.keys(initialStorage.local).length === 0 && Object.keys(initialStorage.session).length === 0,
    'Temporary browser storage is empty before seeding the test fixture', initialStorage);

  const settings = JSON.stringify({ unlocked: 40, adsRemoved: false, mute: false });
  const savedRun = JSON.stringify(snapshot);
  await evaluate(`(() => {
    localStorage.setItem('hexpour_v1',${JSON.stringify(settings)});
    localStorage.setItem('hexpour:howto','1');
    localStorage.setItem('hexpour:in-progress',${JSON.stringify(savedRun)});
    return true;
  })()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`!!document.querySelector('#home.screen.active button.home-resume')`, 'Home with the isolated Level 40 fixture');
  await pressKey('Tab');
  const playFocus = await evaluate(focusExpression);
  await pressKey('Tab');
  const resumeFocus = await evaluate(focusExpression);
  check(playFocus?.text === 'Play' && resumeFocus?.text === 'Resume Level 40 · 1 pour',
    'Keyboard reaches Home Play and the Level 40 Resume action', { playFocus, resumeFocus });
  await pressKey('Enter');
  await waitFor(`!!document.querySelector('#play.screen.active')&&document.querySelector('#play .title')?.textContent==='Level 40'`, 'resumed Level 40');
  const playStart = await evaluate(`({focus:${focusExpression},move:document.querySelector('#play .move-status')?.textContent,undoDisabled:document.querySelector('#play .toolbar button')?.disabled})`);
  check(playStart.move === 'Pours: 1' && playStart.undoDisabled === false && playStart.focus?.text === 'Keyboard and screen reader controls',
    'Resuming Level 40 restores its fixture and visibly focuses keyboard controls', playStart);
  await pressKey('Enter');
  await pressKey('Tab');
  let cellFocus = await evaluate(`({label:document.activeElement?.getAttribute('aria-label'),className:document.activeElement?.className})`);
  let steps = 0;
  while (!(cellFocus?.label?.includes('q 0, r -1') && cellFocus?.className?.includes('cell-control')) && steps++ < 25) {
    await pressKey('Tab');
    cellFocus = await evaluate(`({label:document.activeElement?.getAttribute('aria-label'),className:document.activeElement?.className})`);
  }
  check(cellFocus?.label?.includes('q 0, r -1'), 'Keyboard reaches the controlled mixed source cell', cellFocus);
  await pressKey('Enter');
  let destination = null;
  steps = 0;
  while (steps++ < 20) {
    await pressKey('Tab', true);
    destination = await evaluate(`({label:document.activeElement?.getAttribute('aria-label'),legal:document.activeElement?.classList.contains('legal-target'),focusVisible:document.activeElement?.matches(':focus-visible')})`);
    if (destination?.label?.includes('q -1, r -1')) break;
  }
  check(destination?.label?.includes('q -1, r -1') && destination?.legal && destination?.focusVisible,
    'Keyboard reaches the adjacent legal final-pour target with visible focus', destination);
  await pressKey('Enter');
  await waitFor(`!!document.querySelector('#win.screen.active')`, 'Level 40 terminal completion');
  await pressKey('Enter');
  const rapidReplay = await evaluate(`(() => {
    const focus=document.activeElement;
    const storage=Object.fromEntries(Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).filter(key=>key!==null).sort().map(key=>[key,localStorage.getItem(key)]));
    return {activeScreen:[...document.querySelectorAll('.screen.active')].map(node=>node.id),heading:document.querySelector('#win h1')?.textContent?.trim(),focus:{text:(focus?.innerText||focus?.textContent||'').trim(),focusVisible:focus?.matches(':focus-visible'),outlineStyle:focus?getComputedStyle(focus).outlineStyle:null},move:document.querySelector('#play .move-status')?.textContent,settings:JSON.parse(storage['hexpour_v1']||'null'),save:storage['hexpour:in-progress'],completed:storage['hexpour:completed-levels'],replayButtons:[...document.querySelectorAll('#win .home-actions button')].filter(button=>button.textContent.trim()==='All 40 clear — Replay').length};
  })()`);
  check(rapidReplay.activeScreen.length === 1 && rapidReplay.activeScreen[0] === 'win' && rapidReplay.heading === 'Hive clear!' && rapidReplay.focus.text === 'All 40 clear — Replay' && rapidReplay.focus.focusVisible && rapidReplay.focus.outlineStyle === 'solid' && rapidReplay.move === 'Pours: 2' && rapidReplay.settings?.unlocked === 40 && rapidReplay.save === undefined && rapidReplay.completed === '[40]' && rapidReplay.replayButtons === 1,
    'A rapid second Enter after the final pour cannot activate Replay or start Level 1', rapidReplay);
  const win = await evaluate(`(() => {
    const buttons=[...document.querySelectorAll('#win .home-actions button')];
    const focus=document.activeElement;
    const storage=Object.fromEntries(Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).filter(key=>key!==null).sort().map(key=>[key,localStorage.getItem(key)]));
    return {heading:document.querySelector('#win h1')?.textContent?.trim(),tagline:document.querySelector('#win .tagline')?.textContent?.trim(),buttons:buttons.map(button=>button.textContent.trim()),dialog:!!document.querySelector('#win [role="dialog"]'),focus:{text:(focus?.innerText||focus?.textContent||'').trim(),focusVisible:focus?.matches(':focus-visible'),outlineStyle:focus?getComputedStyle(focus).outlineStyle:null},storage};
  })()`);
  const storedSettings = JSON.parse(win.storage['hexpour_v1'] || 'null');
  check(win.heading === 'Hive clear!' && win.tagline?.includes('Level 40 complete') && win.buttons[0] === 'All 40 clear — Replay' && !win.buttons.some(text => /Level 41|Next|Continue/i.test(text)) && !win.dialog,
    'Final win announces completion without Next, Continue, Level 41, or modal-dialog semantics', win);
  check(win.focus?.text === 'All 40 clear — Replay' && win.focus.focusVisible && win.focus.outlineStyle === 'solid',
    'Final win exposes visible keyboard focus on the Replay action', win.focus);
  check(storedSettings?.unlocked === 40 && win.storage['hexpour:in-progress'] === undefined && win.storage['hexpour:completed-levels'] === '[40]',
    'Win clears the saved puzzle, records Level 40 complete, and keeps the unlock ceiling at 40', { storedSettings, save: win.storage['hexpour:in-progress'], completed: win.storage['hexpour:completed-levels'] });
  const axTree = await command('Accessibility.getFullAXTree');
  const axNodes = (axTree.nodes || []).filter((node) => ['heading', 'button', 'dialog'].includes(node.role?.value)).map((node) => ({ role: node.role?.value, name: node.name?.value }));
  check(axNodes.some((node) => node.role === 'heading' && node.name === 'Hive clear!') && axNodes.some((node) => node.role === 'button' && node.name === 'All 40 clear — Replay'),
    'Browser accessibility tree exposes the completion heading and Replay control', axNodes);

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
  await pressKey('Enter');
  await waitFor(`!!document.querySelector('#play.screen.active')&&document.querySelector('#play .title')?.textContent==='Level 1'`, 'Replay to Level 1');
  const replay = await evaluate(`({focus:${focusExpression},move:document.querySelector('#play .move-status')?.textContent,undoDisabled:document.querySelector('#play .toolbar button')?.disabled,settings:JSON.parse(localStorage.getItem('hexpour_v1')||'null'),save:localStorage.getItem('hexpour:in-progress'),completed:localStorage.getItem('hexpour:completed-levels')})`);
  check(replay.focus?.text === 'Keyboard and screen reader controls' && replay.focus.focusVisible && replay.focus.outlineStyle === 'solid',
    'Keyboard Replay transfers visible focus into the new Level 1 controls', replay.focus);
  check(replay.move === 'Pours: 0' && replay.undoDisabled === true && replay.save === null && replay.settings?.unlocked === 40 && replay.completed === '[40]',
    'Replay starts a clean Level 1 and preserves terminal completion without Level 41', replay);
  await evaluate(`document.querySelector('#play button[aria-label="Back to levels"]')?.click()`);
  await waitFor(`!!document.querySelector('#levels.screen.active .level-grid')`, 'Level Select after Replay');
  const picker = await evaluate(`({count:document.querySelectorAll('#levels .level-btn').length,level40:document.querySelector('#levels .level-btn[aria-label^="Level 40"]')?.getAttribute('aria-label'),hasLevel41:[...document.querySelectorAll('#levels .level-btn')].some(button=>button.getAttribute('aria-label')?.startsWith('Level 41')),unlocked:JSON.parse(localStorage.getItem('hexpour_v1')||'{}').unlocked})`);
  check(picker.count === 40 && picker.level40 === 'Level 40, complete' && picker.hasLevel41 === false && picker.unlocked === 40,
    'Level Select marks Level 40 complete while exposing no Level 41 and keeping unlocks capped at 40', picker);
} catch (error) {
  console.error(error?.stack || String(error));
  checks.push({ label: 'Browser test execution', ok: false, details: String(error) });
} finally {
  console.log('LEVEL40_TERMINAL_RESULT ' + JSON.stringify({ checks }, null, 2));
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
if (checks.some((result) => !result.ok)) process.exitCode = 1;

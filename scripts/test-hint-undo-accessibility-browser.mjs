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
].find((candidate) => existsSync(candidate));
if (!chromiumPath) throw new Error('Chromium was not found. Install Chromium or set CHROMIUM_BIN.');

const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-hint-undo-'));
if ((await readdir(profileDirectory)).length !== 0) {
  throw new Error('The disposable Chromium profile must be empty before launch.');
}
let server;
let browser;
let socket;
let nextCommandId = 0;
const pending = new Map();
const checks = [];

function check(ok, label, details) {
  checks.push({ label, ok, details });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`);
}

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
  const diagnostic = await evaluate('({url:location.href,title:document.title,body:document.body?.innerText?.slice(0,240)})');
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}

async function pressKey(key, shift = false) {
  const virtualKey = ({ Tab: 9, Enter: 13, Escape: 27, Space: 32 })[key];
  if (!virtualKey) throw new Error(`Unsupported keyboard key: ${key}`);
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

async function tabUntil(expression, label, maxTabs = 70, shift = false) {
  for (let index = 0; index <= maxTabs; index++) {
    if (await evaluate(expression)) return;
    await pressKey('Tab', shift);
  }
  const active = await evaluate(`(() => { const e=document.activeElement; return {tag:e?.tagName,text:(e?.innerText||e?.textContent||'').trim(),label:e?.getAttribute('aria-label')}; })()`);
  throw new Error(`Keyboard Tab did not reach ${label}: ${JSON.stringify(active)}`);
}

const stateExpression = `(() => {
  const play=document.querySelector('#play.screen.active');
  if(!play) return null;
  const controls=[...play.querySelectorAll('.cell-control')];
  const normalize=label=>label?.replace(' Selected source. Press again to deselect.','').replace(' Legal destination from selected source. Press to pour.','').replace(' Blocked adjacent cell. Cannot be used as a destination.','');
  const canvas=play.querySelector('.play-canvas-wrap canvas');
  let canvasHash=null;
  if(canvas?.width&&canvas?.height){
    const pixels=canvas.getContext('2d')?.getImageData(0,0,canvas.width,canvas.height).data;
    if(pixels){let hash=2166136261;for(let i=0;i<pixels.length;i+=4){hash=Math.imul(hash^pixels[i],16777619);hash=Math.imul(hash^pixels[i+1],16777619);hash=Math.imul(hash^pixels[i+2],16777619);hash=Math.imul(hash^pixels[i+3],16777619);}canvasHash=(hash>>>0).toString(16);}
  }
  const active=document.activeElement;
  const toast=document.querySelector('.toast');
  const selection=play.querySelector('.screen-reader-status');
  const hint=[...play.querySelectorAll('.toolbar button')].find(button=>button.textContent.trim().startsWith('Hint:'));
  const undo=[...play.querySelectorAll('.toolbar button')].find(button=>button.textContent.trim()==='Undo');
  const summary=play.querySelector('.accessible-board > summary');
  return {
    title:play.querySelector('.topbar .title')?.textContent.trim(),
    board:controls.map(button=>[normalize(button.getAttribute('aria-label')),button.disabled]),
    cells:controls.map(button=>({label:button.getAttribute('aria-label'),disabled:button.disabled})),
    moveStatus:play.querySelector('.move-status')?.textContent,
    undoDisabled:undo?.disabled,
    hintText:hint?.textContent.trim(),
    hintLabel:hint?.getAttribute('aria-label'),
    toast:{text:toast?.textContent,role:toast?.getAttribute('role'),live:toast?.getAttribute('aria-live'),atomic:toast?.getAttribute('aria-atomic'),hidden:toast?.hidden},
    selectionText:selection?.textContent,
    selectionRole:selection?.getAttribute('role'),
    selectionLive:selection?.getAttribute('aria-live'),
    settings:localStorage.getItem('hexpour_v1'),
    progress:localStorage.getItem('hexpour:in-progress'),
    active:{tag:active?.tagName,text:(active?.innerText||active?.textContent||'').trim().replace(/\\s+/g,' ').slice(0,100),label:active?.getAttribute('aria-label'),className:typeof active?.className==='string'?active.className:'',isSummary:active===summary,connected:active?.isConnected===true,disabled:active instanceof HTMLButtonElement&&active.disabled},
    canvasHash
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
  const localUrl = `http://127.0.0.1:${address.port}/hexpour/`;
  const targetUrl = requestedUrl || localUrl;
  const expectedHashedAssets = requestedUrl
    ? (await readdir(resolve(repoRoot, 'dist/assets'))).filter((name) =>
        /^index-[A-Za-z0-9_-]+\.(?:js|css)$/.test(name),
      )
    : [];
  if (requestedUrl && !['js', 'css'].every((extension) =>
    expectedHashedAssets.some((name) => name.endsWith(`.${extension}`)),
  )) {
    throw new Error('The production check needs the current build’s hashed JavaScript and CSS assets in dist/assets.');
  }
  const { getLevel } = await server.ssrLoadModule('/src/levels/index.ts');
  const { hintPour, loadBoard } = await server.ssrLoadModule('/src/game/engine.ts');
  const level = getLevel(39);
  const openingHint = hintPour(loadBoard(level));
  if (!openingHint) throw new Error('Level 39 has no legal opening hint.');
  const sourceLabel = `Hex cell q ${openingHint.from.q}, r ${openingHint.from.r}`;
  const destinationLabel = `Hex cell q ${openingHint.to.q}, r ${openingHint.to.r}`;
  const expectedHintStatus = `Hint highlighted: pour from ${sourceLabel} to ${destinationLabel}.`;

  console.log(`Checking Level 39 behavior in a fresh ${requestedUrl ? 'live production' : 'local'} Chromium profile: ${targetUrl}`);
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
    catch { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); }
  }
  if (!portContents) throw new Error('Chromium did not publish a DevTools endpoint.');
  const devToolsPort = Number(portContents.trim().split(/\s+/)[0]);
  let pageTarget;
  const targetDeadline = Date.now() + 10_000;
  while (Date.now() < targetDeadline && !pageTarget) {
    try {
      const response = await fetch(`http://127.0.0.1:${devToolsPort}/json/list`);
      pageTarget = (await response.json()).find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); }
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
    socket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('Could not connect to Chromium.')); }, { once: true });
  });

  await command('Page.enable');
  await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 844, height: 720, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: targetUrl });
  await waitFor(`document.readyState==='complete'&&!!document.querySelector('#home.screen.active')`, 'the clean Home screen');
  if (requestedUrl) {
    const loadedAssetNames = await evaluate(`performance.getEntriesByType('resource').map(({name})=>new URL(name).pathname.split('/').pop()).filter(Boolean)`);
    check(expectedHashedAssets.every((name) => loadedAssetNames.includes(name)),
      'Live production loaded the current build’s hashed app JavaScript and CSS', {
        expected: expectedHashedAssets,
        loaded: loadedAssetNames,
      });
  }
  const initialStorage = await evaluate(`({local:localStorage.length,session:sessionStorage.length})`);
  check(initialStorage.local === 0 && initialStorage.session === 0, 'Fresh browser storage is empty before test setup', initialStorage);
  await evaluate(`(()=>{localStorage.setItem('hexpour_v1',${JSON.stringify(JSON.stringify({ unlocked: 39, adsRemoved: false, mute: false }))});localStorage.setItem('hexpour:howto','1');sessionStorage.setItem('hexpour:a2hs','1');return true})()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`!!document.querySelector('#home.screen.active .level-select-opener')`, 'Home with only test-owned Level 39 unlock');

  await pressKey('Tab');
  check(await evaluate(`document.activeElement?.textContent.trim()==='Play'`), 'Keyboard reaches Play from Home');
  await pressKey('Tab');
  check(await evaluate(`document.activeElement?.textContent.trim()==='Levels'`), 'Keyboard reaches Levels from Home');
  await pressKey('Enter');
  await waitFor(`!!document.querySelector('#levels.screen.active .level-btn')`, 'the unlocked level picker');
  await tabUntil(`document.activeElement?.getAttribute('aria-label')==='Level 39'`, 'Level 39');
  await pressKey('Enter');
  await waitFor(`document.querySelector('#play.screen.active .topbar .title')?.textContent.trim()==='Level 39'`, 'Level 39 play screen');
  await evaluate('new Promise(resolveFrame=>requestAnimationFrame(()=>requestAnimationFrame(resolveFrame)))');

  await tabUntil(`document.activeElement?.getAttribute('aria-label')==='Hint. One free hint remaining.'`, 'the free Hint button');
  const beforeHint = await evaluate(stateExpression);
  await pressKey('Enter');
  await waitFor(`document.querySelector('.toast')?.textContent.includes('Hint')`, 'Hint feedback');
  await evaluate('new Promise(resolveFrame=>requestAnimationFrame(()=>requestAnimationFrame(resolveFrame)))');
  const afterHint = await evaluate(stateExpression);
  check(afterHint.toast.text === expectedHintStatus, 'Hint status concisely names the highlighted source and destination', {
    expected: expectedHintStatus,
    actual: afterHint.toast.text,
  });
  check(afterHint.toast.role === 'status' && afterHint.toast.live === 'polite' && afterHint.toast.atomic === 'true' &&
    afterHint.selectionText === '', 'Hint uses the existing single polite status without duplicating selection announcements', {
    toast: afterHint.toast,
    selectionText: afterHint.selectionText,
  });
  check(afterHint.canvasHash !== beforeHint.canvasHash, 'Hint visibly changes the board highlight');
  check(afterHint.hintText === 'Hint: ad' &&
    afterHint.hintLabel === 'Hint. No free hints remain; opens the rewarded-ad prompt.',
  'The free Hint is consumed once and the existing rewarded-hint label is preserved', {
    text: afterHint.hintText,
    label: afterHint.hintLabel,
  });

  await tabUntil(`document.activeElement?.matches('.accessible-board > summary')`, 'the keyboard controls disclosure');
  await pressKey('Enter');
  check(await evaluate(`document.querySelector('#play.screen.active .accessible-board')?.open===true`), 'Keyboard opens the cell controls disclosure');
  const cellOrder = await evaluate(`(()=>[...document.querySelectorAll('#play.screen.active .cell-control:not(:disabled)')].map((button,index)=>({index,label:button.getAttribute('aria-label')})))()`);
  const coord = (cell) => `Hex cell q ${cell.q}, r ${cell.r}:`;
  const sourceIndex = cellOrder.findIndex((cell) => cell.label.startsWith(coord(openingHint.from)));
  const destinationIndex = cellOrder.findIndex((cell) => cell.label.startsWith(coord(openingHint.to)));
  if (sourceIndex < 0 || destinationIndex < 0) throw new Error('Hint cells are not present as enabled keyboard controls.');
  await tabUntil(`document.activeElement?.getAttribute('aria-label')?.startsWith(${JSON.stringify(coord(openingHint.from))})`, 'the hinted source cell', 40);
  await pressKey('Enter');
  check(await evaluate(`document.activeElement?.getAttribute('aria-pressed')==='true'`), 'Keyboard selects the hinted source cell');
  const stepCount = Math.abs(destinationIndex - sourceIndex);
  for (let index = 0; index < stepCount; index++) {
    await pressKey('Tab', destinationIndex < sourceIndex);
  }
  check(await evaluate(`document.activeElement?.getAttribute('aria-label')?.startsWith(${JSON.stringify(coord(openingHint.to))})`), 'Keyboard reaches the hinted destination cell');
  await pressKey('Enter');
  await waitFor(`document.querySelector('#play.screen.active .move-status')?.textContent==='Pours: 1'`, 'one keyboard-only Level 39 move');
  const afterMove = await evaluate(stateExpression);
  check(afterMove.undoDisabled === false && !!afterMove.progress && afterMove.hintText === 'Hint: ad',
    'A keyboard move creates one undo entry without restoring the spent free Hint', {
    undoDisabled: afterMove.undoDisabled,
    saved: !!afterMove.progress,
    hintText: afterMove.hintText,
  });

  await tabUntil(`document.activeElement?.getAttribute('aria-label')==='Undo last pour.'`, 'enabled Undo', 50, true);
  await pressKey('Enter');
  await waitFor(`document.querySelector('#play.screen.active .move-status')?.textContent==='Pours: 0'`, 'Undo to restore the original Level 39 board');
  const afterUndo = await evaluate(stateExpression);
  check(JSON.stringify(afterUndo.board) === JSON.stringify(beforeHint.board), 'Undo restores the exact Level 39 board');
  check(afterUndo.undoDisabled === true && afterUndo.progress === null && afterUndo.settings === beforeHint.settings &&
    afterUndo.hintText === 'Hint: ad', 'Undo changes only the move/save state and preserves settings and free-hint consumption', {
    moveStatus: afterUndo.moveStatus,
    undoDisabled: afterUndo.undoDisabled,
    savedProgress: afterUndo.progress,
    settingsPreserved: afterUndo.settings === beforeHint.settings,
    hintText: afterUndo.hintText,
  });
  check(afterUndo.active.tag !== 'BODY' && afterUndo.active.connected && !afterUndo.active.disabled && afterUndo.active.isSummary,
    'Keyboard Undo returns focus to the relevant, enabled board-controls disclosure instead of BODY', afterUndo.active);

  console.log(`\n${checks.filter(({ ok }) => ok).length}/${checks.length} browser/DOM checks passed.`);
  if (checks.some(({ ok }) => !ok)) process.exitCode = 1;
} finally {
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await new Promise((resolveClose) => {
      if (browser.exitCode !== null) return resolveClose();
      browser.once('exit', resolveClose);
      setTimeout(resolveClose, 3000).unref();
    });
  }
  if (server) await server.close();
  await rm(profileDirectory, { recursive: true, force: true });
}

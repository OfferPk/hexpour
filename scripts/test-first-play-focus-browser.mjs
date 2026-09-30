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

const profileDirectory = await mkdtemp(join(tmpdir(), 'hexpour-first-play-focus-'));
if ((await readdir(profileDirectory)).length !== 0) {
  throw new Error('The disposable Chromium profile must be empty before launch.');
}
let server;
let browser;
let socket;
let nextCommandId = 0;
const pending = new Map();
const failures = [];

function check(condition, message, details) {
  if (condition) return;
  failures.push({ message, details });
  console.error(`FAIL ${message}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`);
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
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(await evaluate('({url:location.href,title:document.title,body:document.body?.innerText?.slice(0,200)})'))}`);
}

async function pressKey(key, shift = false) {
  const definitions = {
    Tab: { key: 'Tab', code: 'Tab', virtualKey: 9 },
    Enter: { key: 'Enter', code: 'Enter', virtualKey: 13, character: '\r' },
    Escape: { key: 'Escape', code: 'Escape', virtualKey: 27 },
    Space: { key: ' ', code: 'Space', virtualKey: 32, character: ' ' },
  };
  const definition = definitions[key];
  if (!definition) throw new Error(`Unsupported test key: ${key}`);
  const params = {
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.virtualKey,
    nativeVirtualKeyCode: definition.virtualKey,
    modifiers: shift ? 8 : 0,
  };
  await command('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
  if (definition.character) {
    await command('Input.dispatchKeyEvent', {
      type: 'char',
      ...params,
      text: definition.character,
      unmodifiedText: definition.character,
    });
  }
  await command('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

const storageExpression = `(() => {
  const read = (storage) => Object.fromEntries(
    Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key) => key !== null).sort().map((key) => [key, storage.getItem(key)]),
  );
  return { local: read(localStorage), session: read(sessionStorage) };
})()`;
const focusExpression = `(() => {
  const node = document.activeElement;
  if (!node) return null;
  const style = getComputedStyle(node);
  return {
    tag: node.tagName,
    text: (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100),
    label: node.getAttribute('aria-label'),
    className: typeof node.className === 'string' ? node.className : '',
    focusVisible: node.matches(':focus-visible'),
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
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
  const targetUrl = `http://127.0.0.1:${address.port}/hexpour/`;

  console.log(`Testing first-run keyboard focus in a new disposable Chromium profile: ${targetUrl}`);
  console.log(`Profile directory empty before Chromium launch: ${(await readdir(profileDirectory)).length === 0}`);
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
  if (!portContents) throw new Error('Chromium did not publish its DevTools endpoint.');
  const port = Number(portContents.trim().split(/\s+/)[0]);
  let target;
  const targetDeadline = Date.now() + 10_000;
  while (Date.now() < targetDeadline && !target) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  if (!target) throw new Error('No fresh Chromium page target was found.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message || 'CDP command failed.'));
    else request.resolve(message.result || {});
  });
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('DevTools socket open timed out.')), 5_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('Could not connect to fresh Chromium.')); }, { once: true });
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Accessibility.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 844, height: 720, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: targetUrl });
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#home.screen.active')`, 'the first-run Home screen');
  await waitFor(`!!document.querySelector('.overlay.open [role="dialog"]')`, 'the first-run How-to dialog');

  const emptyBeforeInteraction = await evaluate(storageExpression);
  const dialog = await evaluate(`(() => {
    const modal = document.querySelector('.overlay.open [role="dialog"]');
    const focus = document.activeElement;
    return {
      title: modal?.getAttribute('aria-labelledby') ? document.getElementById(modal.getAttribute('aria-labelledby'))?.textContent : null,
      modal: modal?.getAttribute('aria-modal'),
      buttonOrder: [...(modal?.querySelectorAll('button') || [])].map((button) => button.textContent.trim()),
      focusedText: focus?.textContent?.trim(),
      focusVisible: focus?.matches(':focus-visible'),
      focusOutlineStyle: focus ? getComputedStyle(focus).outlineStyle : null,
      focusOutline: focus ? getComputedStyle(focus).outlineWidth : null,
    };
  })()`);
  const axTree = await command('Accessibility.getFullAXTree');
  const axDialog = (axTree.nodes || []).find((node) => node.role?.value === 'dialog');
  check(Object.keys(emptyBeforeInteraction.local).length === 0 && Object.keys(emptyBeforeInteraction.session).length === 0,
    'Local and session storage are empty before any test setup/interaction', emptyBeforeInteraction);
  check(dialog.title === 'How to play' && dialog.modal === 'true' && dialog.buttonOrder.join('|') === 'Got it' &&
    dialog.focusedText === 'Got it',
  'Fresh How-to has a modal accessible name and initial focus on Got it', { dialog, axDialog: axDialog?.name?.value });
  check(axDialog?.name?.value === 'How to play', 'DOM accessibility tree exposes the How-to dialog name', axDialog?.name?.value);

  await pressKey('Tab');
  const afterDialogTab = await evaluate(focusExpression);
  await pressKey('Tab', true);
  const afterDialogReverseTab = await evaluate(focusExpression);
  check(afterDialogTab?.text === 'Got it' && afterDialogReverseTab?.text === 'Got it',
    'Tab and Shift+Tab remain within the single-action first-run dialog', { afterDialogTab, afterDialogReverseTab });
  check(afterDialogTab?.focusVisible && afterDialogTab.outlineStyle === 'solid' &&
    afterDialogReverseTab?.focusVisible && afterDialogReverseTab.outlineStyle === 'solid',
  'Keyboard traversal keeps a visible focus indicator on the dialog action', { afterDialogTab, afterDialogReverseTab });

  await pressKey('Space');
  await waitFor(`!document.querySelector('.overlay.open') && !!document.querySelector('#home.screen.active')`, 'How-to dismissal to Home by Space');
  const homeState = await evaluate(`({focus:${focusExpression}, storage:${storageExpression}})`);
  check(homeState.storage.local['hexpour:howto'] === '1' && homeState.storage.session &&
    Object.keys(homeState.storage.local).length === 1 && Object.keys(homeState.storage.session).length === 0,
  'How-to dismissal changes only the howto-seen marker in the fresh profile', homeState.storage);
  check(homeState.focus?.text === 'Play' && homeState.focus?.focusVisible && homeState.focus?.outlineStyle === 'solid',
    'How-to dismissal returns visible focus to the primary Play action', homeState.focus);

  const homeTabs = [];
  if (homeState.focus?.text !== 'Play') await pressKey('Tab');
  const homeStart = await evaluate(focusExpression);
  if (homeStart?.text === 'Play') {
    for (let index = 0; index < 4; index++) {
      await pressKey('Tab');
      homeTabs.push(await evaluate(focusExpression));
    }
  }
  check(homeTabs.map((item) => item?.text).join('|') === 'Levels|How to play|Settings|Got it',
    'Fresh Home Tab order proceeds from Play through Levels, How to play, Settings, and the A2HS dismissal', homeTabs);

  for (let index = 0; index < 4; index++) await pressKey('Tab', true);
  const playFocusBeforeStart = await evaluate(focusExpression);
  check(playFocusBeforeStart?.text === 'Play' && playFocusBeforeStart.focusVisible,
    'Reverse Tab returns to the visible Play action', playFocusBeforeStart);
  await pressKey('Enter');
  await waitFor(`!!document.querySelector('#play.screen.active')`, 'Level 1 after keyboard activation of Play');
  const playEntry = await evaluate(`({focus:${focusExpression},screen:[...document.querySelectorAll('.screen.active')].map(node=>node.id),level:document.querySelector('#play .title')?.textContent?.trim(),summary:document.querySelector('#play .accessible-board > summary')?.textContent?.trim(),storage:${storageExpression}})`);
  check(playEntry.level === 'Level 1', 'Enter on Play starts the expected first level', playEntry);
  check(playEntry.focus?.text === 'Keyboard and screen reader controls' && playEntry.focus?.focusVisible && playEntry.focus?.outlineStyle === 'solid',
    'Starting Level 1 places visible focus on its keyboard-accessible board controls', playEntry.focus);
  check(playEntry.screen.join(',') === 'play' && playEntry.storage.local['hexpour:howto'] === '1' &&
    Object.keys(playEntry.storage.local).length === 1 && Object.keys(playEntry.storage.session).length === 0,
  'Starting a fresh level preserves the default unlock/settings state and creates no saved puzzle', playEntry.storage);

  if (playEntry.focus?.text === 'Keyboard and screen reader controls') {
    await pressKey('Space');
    const disclosure = await evaluate(`({open:document.querySelector('#play .accessible-board')?.open,focus:${focusExpression}})`);
    check(disclosure.open === true, 'Space activates the keyboard-controls disclosure', disclosure);
    await pressKey('Tab');
    const firstCell = await evaluate(`({focus:${focusExpression},label:document.activeElement?.getAttribute('aria-label'),pressed:document.activeElement?.getAttribute('aria-pressed')})`);
    check(firstCell.focus?.className === 'cell-control' && firstCell.label,
      'Tab from the expanded disclosure reaches a labeled keyboard cell control', firstCell);
    if (firstCell.focus?.className === 'cell-control') {
      await pressKey('Space');
      const selected = await evaluate(`({pressed:document.activeElement?.getAttribute('aria-pressed'),focus:${focusExpression},status:document.querySelector('#play .screen-reader-status')?.textContent,storage:${storageExpression}})`);
      check(selected.pressed === 'true' && selected.status.includes('Selected source:'),
        'Space activates the focused cell as a keyboard-selected source', selected);
      check(selected.focus?.focusVisible && selected.focus?.outlineStyle === 'solid',
        'Selected board cell keeps a visible keyboard focus indicator', selected.focus);
      check(selected.storage.local['hexpour:in-progress'] === undefined &&
        selected.storage.local['hexpour_v1'] === undefined &&
        JSON.stringify(selected.storage.session) === JSON.stringify(emptyBeforeInteraction.session),
      'Selecting a source does not create or mutate persisted puzzle/settings state', selected.storage);
    }
  }

  const report = {
    status: failures.length ? 'FAIL' : 'PASS',
    target: targetUrl,
    profile: 'new empty disposable Chromium profile; empty before launch and local/session storage verified empty before interaction; removed after test',
    spokenReader: 'not tested',
    dialog: { ...dialog, axName: axDialog?.name?.value, tab: afterDialogTab.text, shiftTab: afterDialogReverseTab.text },
    home: { afterHowtoDismiss: homeState.focus, tabOrder: homeTabs.map((item) => item?.text), returnedByShiftTab: playFocusBeforeStart },
    play: { screen: playEntry.screen, level: playEntry.level, focus: playEntry.focus },
    storageBefore: emptyBeforeInteraction,
    storageAfterHowto: homeState.storage,
    storageAtPlayEntry: playEntry.storage,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
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

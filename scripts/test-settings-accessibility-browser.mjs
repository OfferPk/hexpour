import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';

const repoRoot = process.cwd();
const chromiumPath = process.env.CHROMIUM_BIN || [
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome',
].find((candidate) => existsSync(candidate));
if (!chromiumPath) throw new Error('Chromium not found.');
const profile = await mkdtemp(join(tmpdir(), 'hexpour-settings-review-'));
let server;
let browser;
let socket;
let nextId = 0;
const pending = new Map();

function command(method, params = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCommand(new Error(`Timed out: ${method}`));
    }, 8000);
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.result?.exception?.description || response.exceptionDetails.text);
  return response.result?.value;
}
async function waitFor(expression, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function pressKey(key, shift = false) {
  const virtualKey = ({ Tab: 9, Enter: 13 })[key];
  const params = { key, code: key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers: shift ? 8 : 0 };
  await command('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
  if (key === 'Enter') await command('Input.dispatchKeyEvent', { type: 'char', ...params, text: '\r', unmodifiedText: '\r' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

try {
  const requestedUrl = process.env.HEXPOUR_TEST_URL;
  if (requestedUrl && requestedUrl !== 'https://offerpk.github.io/hexpour/') {
    throw new Error('HEXPOUR_TEST_URL is restricted to the canonical Hexpour Pages URL.');
  }
  let url = requestedUrl;
  if (!url) {
    server = await createServer({ configFile: resolve(repoRoot, 'vite.config.ts'), root: repoRoot, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not provide a loopback address.');
    url = `http://127.0.0.1:${address.port}/hexpour/`;
  }
  browser = spawn(chromiumPath, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  let contents;
  const portDeadline = Date.now() + 10000;
  while (Date.now() < portDeadline) {
    if (browser.exitCode !== null) throw new Error('Chromium exited before DevTools started.');
    try { contents = await readFile(portFile, 'utf8'); break; } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  if (!contents) throw new Error('Chromium did not publish its DevTools port.');
  const port = Number(contents.trim().split(/\s+/)[0]);
  let target;
  const targetDeadline = Date.now() + 10000;
  while (Date.now() < targetDeadline && !target) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl); }
    catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  if (!target) throw new Error('No fresh Chromium page target.');
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
    const timer = setTimeout(() => rejectOpen(new Error('DevTools WebSocket open timeout.')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('DevTools WebSocket error.')); }, { once: true });
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Accessibility.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 844, height: 720, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url });
  await waitFor(`document.readyState==='complete' && !!document.querySelector('#home.screen.active')`, 'fresh Home screen');
  const firstRun = await evaluate(`({dialog:document.querySelector('.overlay.open [role="dialog"]')?.getAttribute('aria-labelledby'),focus:document.activeElement?.textContent?.trim()})`);
  if (!firstRun.dialog) throw new Error(`Fresh profile did not show first-run How to play: ${JSON.stringify(firstRun)}`);
  await evaluate(`document.querySelector('.overlay.open button')?.click()`);
  await waitFor(`!document.querySelector('.overlay.open')`, 'first-run dialog dismissal');

  const settings = JSON.stringify({ unlocked: 3, adsRemoved: true, mute: false });
  const progress = JSON.stringify({ version: 1, levelId: 2, savedAt: Date.now(), moveCount: 1, board: { capacity: 3, cells: [
    { q: 0, r: 0, blocked: false, stack: ['R'] },
    { q: 1, r: 0, blocked: false, stack: ['G', 'R'] },
    { q: 0, r: 1, blocked: false, stack: ['G', 'G'] },
  ] }, undoStack: [{ capacity: 3, cells: [
    { q: 0, r: 0, blocked: false, stack: ['R', 'G', 'G'] },
    { q: 1, r: 0, blocked: false, stack: ['G', 'R'] },
    { q: 0, r: 1, blocked: false, stack: [] },
  ] }] });
  await evaluate(`(()=>{localStorage.setItem('hexpour_v1',${JSON.stringify(settings)});localStorage.setItem('hexpour:in-progress',${JSON.stringify(progress)});sessionStorage.setItem('hexpour:a2hs','1');return true})()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`!!document.querySelector('#home.screen.active .home-resume')`, 'home with isolated saved-run fixture');
  const before = await evaluate(`({settings:localStorage.getItem('hexpour_v1'),progress:localStorage.getItem('hexpour:in-progress'),focus:document.activeElement?.textContent?.trim()})`);
  const homeFocuses = [];
  for (let i = 0; i < 5; i++) { await pressKey('Tab'); homeFocuses.push(await evaluate(`document.activeElement?.textContent?.trim()`)); }
  if (homeFocuses.at(-1) !== 'Settings') throw new Error(`Keyboard did not reach the Settings opener: ${JSON.stringify(homeFocuses)}`);
  await evaluate(`window.__settingsOpener=document.activeElement`);
  await pressKey('Enter');
  await waitFor(`!!document.querySelector('.overlay.open [role="dialog"]')`, 'Settings dialog');
  const ax = await command('Accessibility.getFullAXTree');
  const accessibilitySummary = (ax.nodes || []).filter((node) => (node.role?.value === 'dialog' && node.name?.value === 'Settings') || (node.role?.value === 'button' && ['Mute sound', 'Close'].includes(node.name?.value))).map((node) => ({ role: node.role?.value, name: node.name?.value, focused: node.focused?.value, pressed: node.properties?.find((property) => property.name === 'pressed')?.value?.value }));
  const dialog = await evaluate(`(()=>{const d=document.querySelector('.overlay.open [role="dialog"]');return {name:d?.getAttribute('aria-labelledby')?document.getElementById(d.getAttribute('aria-labelledby'))?.textContent:null,modal:d?.getAttribute('aria-modal'),focus:document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent?.trim(),buttons:[...d.querySelectorAll('button')].map(b=>({text:b.textContent.trim(),disabled:b.disabled,pressed:b.getAttribute('aria-pressed'),name:b.getAttribute('aria-label')}))}})()`);
  const focusStart = await evaluate(`document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent?.trim()`);
  const muteButton = dialog.buttons.find((button) => button.name === 'Mute sound');
  const axMuteButton = accessibilitySummary.find((node) => node.role === 'button' && node.name === 'Mute sound');
  if (!accessibilitySummary.some((node) => node.role === 'dialog' && node.name === 'Settings') || dialog.modal !== 'true' ||
      !muteButton || muteButton.text !== 'Off' || muteButton.pressed !== 'false' || axMuteButton?.pressed !== 'false' || focusStart !== 'Mute sound') {
    throw new Error(`Settings dialog or Mute toggle was not exposed accessibly: ${JSON.stringify({ accessibilitySummary, dialog, focusStart })}`);
  }
  await pressKey('Enter');
  await waitFor(`document.querySelector('.overlay.open [aria-label="Mute sound"]')?.getAttribute('aria-pressed')==='true' && JSON.parse(localStorage.getItem('hexpour_v1')).mute===true`, 'Mute pressed state and persisted setting');
  const toggledOn = await evaluate(`(()=>{const b=document.querySelector('.overlay.open [aria-label="Mute sound"]');return {text:b?.textContent?.trim(),pressed:b?.getAttribute('aria-pressed'),mute:JSON.parse(localStorage.getItem('hexpour_v1')).mute}})()`);
  await pressKey('Enter');
  await waitFor(`document.querySelector('.overlay.open [aria-label="Mute sound"]')?.getAttribute('aria-pressed')==='false' && JSON.parse(localStorage.getItem('hexpour_v1')).mute===false`, 'Mute toggle restored to its original state');
  const toggledBack = await evaluate(`(()=>{const b=document.querySelector('.overlay.open [aria-label="Mute sound"]');return {text:b?.textContent?.trim(),pressed:b?.getAttribute('aria-pressed'),mute:JSON.parse(localStorage.getItem('hexpour_v1')).mute}})()`);
  await pressKey('Tab');
  const focusClose = await evaluate(`document.activeElement?.textContent?.trim()`);
  await pressKey('Tab');
  const focusWrapped = await evaluate(`document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent?.trim()`);
  await pressKey('Tab', true);
  const focusReverseWrapped = await evaluate(`document.activeElement?.textContent?.trim()`);
  await pressKey('Enter');
  await waitFor(`!document.querySelector('.overlay.open')`, 'Settings dialog close');
  const after = await evaluate(`({focusText:document.activeElement?.textContent?.trim(),focusTag:document.activeElement?.tagName,openerFocused:document.activeElement===window.__settingsOpener,settings:localStorage.getItem('hexpour_v1'),progress:localStorage.getItem('hexpour:in-progress'),screen:[...document.querySelectorAll('.screen.active')].map(x=>x.id),resume:document.querySelector('#home .home-resume')?.getAttribute('aria-label')})`);
  if (toggledOn.text !== 'On' || toggledOn.pressed !== 'true' || toggledOn.mute !== true ||
      toggledBack.text !== 'Off' || toggledBack.pressed !== 'false' || toggledBack.mute !== false ||
      focusClose !== 'Close' || focusWrapped !== 'Mute sound' || focusReverseWrapped !== 'Close' || !after.openerFocused ||
      after.settings !== before.settings || after.progress !== before.progress || after.screen.join(',') !== 'home' ||
      !after.resume?.includes('Level 2')) {
    throw new Error(`Settings changed game state or focus unexpectedly: ${JSON.stringify({ toggledOn, toggledBack, focusClose, focusWrapped, focusReverseWrapped, before, after })}`);
  }
  console.log(JSON.stringify({ status: 'PASS', target: url, profile: 'fresh empty temporary Chromium profile; removed after test', accessibilitySummary, dialog, focusStart, toggledOn, toggledBack, focusClose, focusWrapped, focusReverseWrapped, focusReturnedToOpener: after.openerFocused, savedRunAndSettingsPreserved: after.settings === before.settings && after.progress === before.progress, savedRun: JSON.parse(after.progress), settings: after.settings }, null, 2));
} finally {
  try { socket?.close(); } catch {}
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([new Promise((resolveClose) => browser.once('close', resolveClose)), new Promise((resolveDelay) => setTimeout(resolveDelay, 1500))]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  }
  if (server) await server.close();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

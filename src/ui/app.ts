/**
 * HexPour UI — Home, level select, play, win; mute/settings; rewarded-hint demo.
 * Post-v0.1.0 polish: first-run howto, win Share, Home A2HS tip.
 */
import {
  cloneBoard,
  hintPour,
  isWon,
  loadBoard,
  tryPour,
} from '../game/engine';
import {
  A2HS_KEY,
  isHowtoSeen,
  loadPersist,
  markHowtoSeen,
  savePersist,
  unlockLevel,
  type PersistData,
} from '../game/persist';
import type { Axial, BoardState } from '../game/types';
import { LEVEL_COUNT, getLevel } from '../levels/index';
import {
  computeLayout,
  drawBoard,
  hitTest,
  type BoardLayout,
  type RenderSelection,
} from '../render/hexBoard';
import {
  isAdsRemoved,
  purchaseRemoveAds,
  setRewardedPresenter,
  showRewarded,
} from '../ads/stubs';
import { cellAccessibleLabel } from './cellLabel';
import { formatPourCount } from './pourCount';

type Screen = 'home' | 'levels' | 'play' | 'win';

export function mountApp(root: HTMLElement): void {
  let persist: PersistData = loadPersist();
  let screen: Screen = 'home';
  let levelId = 1;
  let board: BoardState | null = null;
  let undoStack: BoardState[] = [];
  let selected: Axial | null = null;
  let hint: { from: Axial; to: Axial } | null = null;
  let freeHintsLeft = 1;
  let layout: BoardLayout | null = null;
  let shakeKey: string | null = null;
  let shakeUntil = 0;
  let raf = 0;
  let cleanupPlay: (() => void) | null = null;
  let moveStatus: HTMLDivElement | null = null;
  let cellButtons = new Map<string, HTMLButtonElement>();
  let toastTimeout = 0;

  const el = {
    home: div('screen', 'home'),
    levels: div('screen', 'levels'),
    play: div('screen', 'play'),
    win: div('screen', 'win'),
    overlay: div('overlay'),
    toast: div('toast'),
  };

  root.append(el.home, el.levels, el.play, el.win, el.overlay, el.toast);
  el.toast.setAttribute('role', 'status');
  el.toast.setAttribute('aria-live', 'polite');
  el.toast.setAttribute('aria-atomic', 'true');

  // Rewarded hints remain explicit demo stubs; interstitials never block play.
  setRewardedPresenter(async (reason) => {
    const ok = await showModalStubConfirm(
      'Ad stub — Rewarded',
      `Watch stub for: ${reason}\nGrant reward?`,
      'Earn reward',
      'Cancel',
    );
    return ok;
  });

  function showToast(msg: string): void {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => el.toast.classList.remove('show'), 1600);
  }

  function showModalStubConfirm(
    title: string,
    body: string,
    yes: string,
    no: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      el.overlay.className = 'overlay open';
      el.overlay.innerHTML = '';
      const modal = div('modal');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-label', title);
      modal.innerHTML = `<div class="ad-stub"><strong>${esc(title)}</strong>${esc(body).replace(/\n/g, '<br/>')}</div>`;
      const row = div('');
      row.style.display = 'flex';
      row.style.gap = '8px';
      row.append(
        button(no, 'btn secondary', () => {
          el.overlay.className = 'overlay';
          el.overlay.innerHTML = '';
          resolve(false);
        }),
        button(yes, 'btn', () => {
          el.overlay.className = 'overlay';
          el.overlay.innerHTML = '';
          resolve(true);
        }),
      );
      modal.append(row);
      el.overlay.append(modal);
      focusDialog(modal);
    });
  }

  // —— How to play (overlay) ——
  function openHowto(fromFirstRun: boolean): void {
    el.overlay.className = 'overlay open';
    el.overlay.innerHTML = '';
    const modal = div('modal howto-modal');
    const h = document.createElement('h2');
    h.textContent = 'How to play';
    h.id = 'howto-title';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', h.id);
    modal.append(h);

    const list = document.createElement('ul');
    list.className = 'howto-list';
    const bullets = [
      'Tap a hex with colors, then tap an <strong>adjacent</strong> hex to pour.',
      'Target must be empty or share the same top color.',
      'Each cell has limited capacity (3–4).',
      '<strong>Win:</strong> every occupied stack is a single pure color.',
      '<strong>Undo</strong> is unlimited.',
      '<strong>Hint:</strong> 1 free per level, then rewarded stub.',
    ];
    for (const html of bullets) {
      const li = document.createElement('li');
      li.innerHTML = html;
      list.append(li);
    }
    modal.append(list);

    const urdu = document.createElement('p');
    urdu.className = 'howto-urdu';
    urdu.textContent = 'Sirf padosi hex par pour — tubes nahi, hive hai.';
    modal.append(urdu);

    modal.append(
      button('Got it', 'btn block', () => {
        markHowtoSeen();
        el.overlay.className = 'overlay';
        el.overlay.innerHTML = '';
        if (fromFirstRun || screen !== 'home') {
          setScreen('home');
        } else {
          // Stay on Home; refresh so A2HS can show after first-run dismiss.
          renderHome();
        }
      }),
    );
    el.overlay.append(modal);
    focusDialog(modal);
  }

  // —— Share helpers ——
  function legacyCopy(text: string): void {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch {
      /* ignore */
    }
  }

  function copyShare(text: string): void {
    const done = () => showToast('Copied');
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(done).catch(() => {
        legacyCopy(text);
        done();
      });
      return;
    }
    legacyCopy(text);
    done();
  }

  function shareWin(): void {
    persist = loadPersist();
    let text = `HexPour — hive clear! Level ${levelId}`;
    if (persist.unlocked > 1) {
      text += ` · unlocked through ${persist.unlocked}`;
    }
    if (typeof navigator.share === 'function') {
      void navigator.share({ title: 'HexPour', text }).catch(() => {
        copyShare(text);
      });
      return;
    }
    copyShare(text);
  }

  function a2hsDismissed(): boolean {
    try {
      return sessionStorage.getItem(A2HS_KEY) === '1';
    } catch {
      return true;
    }
  }

  function dismissA2hs(): void {
    try {
      sessionStorage.setItem(A2HS_KEY, '1');
    } catch {
      /* ignore */
    }
  }

  function isStandalone(): boolean {
    try {
      return window.matchMedia('(display-mode: standalone)').matches;
    } catch {
      return false;
    }
  }

  function setScreen(s: Screen): void {
    if (screen === 'play' && s !== 'play') {
      cleanupPlay?.();
      cleanupPlay = null;
    }
    screen = s;
    for (const k of ['home', 'levels', 'play', 'win'] as const) {
      el[k].classList.toggle('active', k === s);
    }
    cancelAnimationFrame(raf);
    if (s === 'home') renderHome();
    else if (s === 'levels') renderLevels();
    else if (s === 'play') {
      renderPlayShell();
      startLoop();
    } else if (s === 'win') renderWin();
  }

  // —— HOME ——
  function renderHome(): void {
    el.home.innerHTML = '';
    const hero = div('home-hero');
    hero.innerHTML = `
      <svg class="home-hive" viewBox="0 0 100 100" aria-hidden="true">
        <polygon points="50,5 90,27.5 90,72.5 50,95 10,72.5 10,27.5" fill="#3dba7a" opacity="0.9"/>
        <polygon points="50,22 75,36 75,64 50,78 25,64 25,36" fill="#f5ecd8"/>
        <circle cx="50" cy="50" r="10" fill="#c9a227"/>
      </svg>
      <h1>HexPour</h1>
      <p class="tagline">Pour colors across the hive.<br/>Not tubes — adjacent hexes only.</p>
    `;
    const actions = div('home-actions');
    actions.append(
      button('Play', 'btn block', () => {
        levelId = Math.min(persist.unlocked, LEVEL_COUNT);
        startLevel(levelId);
      }),
      button('Levels', 'btn secondary block', () => setScreen('levels')),
      button('How to play', 'btn ghost block', () => openHowto(false)),
      button('Settings', 'btn ghost block', () => openSettings()),
    );
    el.home.append(hero, actions);

    // Soft A2HS tip — Home only; session dismiss; no beforeinstallprompt.
    if (!a2hsDismissed() && !isStandalone()) {
      const tip = div('a2hs');
      const copy = div('a2hs-copy');
      copy.innerHTML =
        '<strong>Add to Home Screen</strong><span>Home screen par add karein — offline khelein.</span>';
      tip.append(
        copy,
        button('Got it', 'btn secondary', () => {
          dismissA2hs();
          tip.remove();
        }),
      );
      el.home.append(tip);
    }
  }

  function openSettings(): void {
    el.overlay.className = 'overlay open';
    el.overlay.innerHTML = '';
    const modal = div('modal');
    const h = document.createElement('h2');
    h.textContent = 'Settings';
    h.id = 'settings-title';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', h.id);
    modal.append(h);

    const muteRow = div('settings-row');
    muteRow.innerHTML = `<span>Mute</span>`;
    const muteBtn = button(persist.mute ? 'On' : 'Off', 'btn secondary', () => {
      persist = savePersist({ mute: !persist.mute });
      muteBtn.textContent = persist.mute ? 'On' : 'Off';
      showToast(persist.mute ? 'Muted' : 'Sound on');
    });
    muteRow.append(muteBtn);
    modal.append(muteRow);

    const adsRow = div('settings-row');
    adsRow.innerHTML = `<span>Remove ads</span>`;
    const adsBtn = button(
      isAdsRemoved() ? 'Owned' : 'Buy (stub)',
      'btn gold',
      async () => {
        if (isAdsRemoved()) {
          showToast('Ads already removed');
          return;
        }
        await purchaseRemoveAds();
        persist = loadPersist();
        adsBtn.textContent = 'Owned';
        showToast('Ads removed (stub)');
      },
    );
    if (isAdsRemoved()) adsBtn.disabled = true;
    adsRow.append(adsBtn);
    modal.append(adsRow);

    modal.append(
      button('Close', 'btn secondary block', () => {
        el.overlay.className = 'overlay';
        el.overlay.innerHTML = '';
      }),
    );
    el.overlay.append(modal);
    focusDialog(modal);
  }

  // —— LEVELS ——
  function renderLevels(): void {
    persist = loadPersist();
    el.levels.innerHTML = '';
    const top = div('topbar');
    top.append(
      button('←', 'btn ghost', () => setScreen('home'), 'Back to home'),
      Object.assign(document.createElement('div'), {
        className: 'title',
        textContent: 'Select level',
      }),
      button(persist.mute ? '🔇' : '🔊', 'btn ghost', () => {
        persist = savePersist({ mute: !persist.mute });
        renderLevels();
      }, persist.mute ? 'Unmute' : 'Mute'),
    );
    const grid = div('level-grid');
    for (let i = 1; i <= LEVEL_COUNT; i++) {
      const locked = i > persist.unlocked;
      const done = i < persist.unlocked;
      const b = document.createElement('button');
      b.className = 'level-btn' + (locked ? ' locked' : '') + (done ? ' done' : '');
      b.textContent = locked ? '🔒' : String(i);
      b.setAttribute('aria-label', locked ? `Level ${i}, locked` : done ? `Level ${i}, complete` : `Level ${i}`);
      b.disabled = locked;
      if (!locked) {
        b.addEventListener('click', () => startLevel(i));
      }
      grid.append(b);
    }
    el.levels.append(top, grid);
  }

  // —— PLAY ——
  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;

  function startLevel(id: number): void {
    const def = getLevel(id);
    if (!def) return;
    levelId = id;
    board = loadBoard(def);
    undoStack = [];
    selected = null;
    hint = null;
    freeHintsLeft = 1;
    shakeKey = null;
    setScreen('play');
  }

  function renderPlayShell(): void {
    cleanupPlay?.();
    cleanupPlay = null;
    if (!board) return;
    el.play.innerHTML = '';
    const top = div('topbar');
    top.append(
      button('←', 'btn ghost', () => setScreen('levels'), 'Back to levels'),
      Object.assign(document.createElement('div'), {
        className: 'title',
        textContent: `Level ${levelId}`,
      }),
      button('⚙', 'btn ghost', () => openSettings(), 'Open settings'),
    );

    moveStatus = div('move-status');
    moveStatus.setAttribute('aria-live', 'polite');
    moveStatus.setAttribute('aria-atomic', 'true');
    updateMoveStatus();

    const wrap = div('play-canvas-wrap');
    canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    wrap.append(canvas);
    ctx = canvas.getContext('2d')!;

    const tools = div('toolbar');
    tools.append(
      button('Undo', 'btn secondary', () => doUndo()),
      button('Hint', 'btn secondary', () => void doHint()),
      button('Restart', 'btn ghost', () => doRestart()),
    );

    const controls = document.createElement('details');
    controls.className = 'accessible-board';
    const summary = document.createElement('summary');
    summary.textContent = 'Keyboard and screen reader controls';
    const instructions = document.createElement('p');
    instructions.textContent =
      'Use Tab to choose a cell and Enter or Space to activate it. ' +
      'Select a cell with tokens, then select an adjacent destination.';
    const grid = div('cell-control-grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Hex cells');
    cellButtons = new Map();
    for (const cell of board.cells.values()) {
      const key = `${cell.q},${cell.r}`;
      const control = button('', 'cell-control', () =>
        activateCell({ q: cell.q, r: cell.r }),
      );
      cellButtons.set(key, control);
      grid.append(control);
    }
    controls.append(summary, instructions, grid);
    el.play.append(top, moveStatus, wrap, tools, controls);
    refreshCellControls();

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (board) layout = computeLayout(board, rect.width, rect.height);
    };
    resize();
    window.addEventListener('resize', resize);

    const onPointer = (ev: PointerEvent) => {
      if (!board || !layout) return;
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const hit = hitTest(board, layout, x, y);
      if (!hit) {
        selected = null;
        refreshCellControls();
        return;
      }
      activateCell(hit);
    };
    canvas.addEventListener('pointerup', onPointer);
    cleanupPlay = () => {
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerup', onPointer);
    };
  }

  function activateCell(hit: Axial): void {
    if (!board) return;
    const cell = board.cells.get(`${hit.q},${hit.r}`);
    if (!cell || cell.blocked) {
      selected = null;
      refreshCellControls();
      return;
    }
    if (!selected) {
      if (cell.stack.length === 0) {
        pulseShake(hit);
        showToast('Pick a cell with colors');
        return;
      }
      selected = hit;
      hint = null;
      refreshCellControls();
      return;
    }
    if (selected.q === hit.q && selected.r === hit.r) {
      selected = null;
      refreshCellControls();
      return;
    }

    undoStack.push(cloneBoard(board));
    const result = tryPour(board, selected, hit);
    if (!result.ok) {
      undoStack.pop();
      pulseShake(hit);
      showToast(pourMsg(result.reason));
      selected = null;
      refreshCellControls();
      return;
    }
    selected = null;
    hint = null;
    updateMoveStatus();
    refreshCellControls();
    if (isWon(board)) onWin();
  }

  function refreshCellControls(): void {
    if (!board) return;
    for (const [key, control] of cellButtons) {
      const cell = board.cells.get(key);
      if (!cell) continue;
      const active = selected?.q === cell.q && selected.r === cell.r;
      control.setAttribute('aria-label', cellAccessibleLabel(cell));
      control.setAttribute('aria-pressed', String(active));
      control.classList.toggle('selected', active);
      control.disabled = cell.blocked;
    }
  }

  function updateMoveStatus(): void {
    if (moveStatus) moveStatus.textContent = `Pours: ${undoStack.length}`;
  }

  function pulseShake(a: Axial): void {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    shakeKey = `${a.q},${a.r}`;
    shakeUntil = performance.now() + 400;
  }

  function pourMsg(reason?: string): string {
    switch (reason) {
      case 'not-adjacent':
        return 'Only adjacent hexes';
      case 'color-mismatch':
        return 'Top colors must match';
      case 'full':
        return 'Cell is full';
      case 'empty-source':
        return 'Nothing to pour';
      case 'blocked':
        return 'Blocked cell';
      default:
        return 'Invalid pour';
    }
  }

  function doUndo(): void {
    if (!board || undoStack.length === 0) {
      showToast('Nothing to undo');
      return;
    }
    board = undoStack.pop()!;
    selected = null;
    hint = null;
    updateMoveStatus();
    refreshCellControls();
  }

  async function doHint(): Promise<void> {
    if (!board) return;
    if (freeHintsLeft > 0) {
      freeHintsLeft--;
      applyHint();
      return;
    }
    const earned = await showRewarded('hint');
    if (earned) applyHint();
    else showToast('Hint cancelled');
  }

  function applyHint(): void {
    if (!board) return;
    const h = hintPour(board);
    if (!h) {
      showToast('No legal moves');
      return;
    }
    hint = h;
    selected = null;
    refreshCellControls();
    showToast('Hint highlighted');
  }

  function doRestart(): void {
    startLevel(levelId);
  }

  function onWin(): void {
    const next = levelId + 1;
    if (next <= LEVEL_COUNT) {
      persist = unlockLevel(next);
    } else {
      // all done — keep unlocked at 40
      persist = unlockLevel(LEVEL_COUNT);
    }
    setScreen('win');
  }

  function startLoop(): void {
    const tick = (now: number) => {
      if (screen !== 'play' || !board || !ctx || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      layout = computeLayout(board, rect.width, rect.height);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const sel: RenderSelection = {
        selected,
        hint,
        shakeKey,
        shakeUntil,
      };
      drawBoard(ctx, board, layout, sel, now);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  // —— WIN ——
  function renderWin(): void {
    el.win.innerHTML = '';
    const hero = div('home-hero');
    const next = levelId + 1;
    const pourCount = formatPourCount(undoStack.length);
    hero.innerHTML = `
      <h1>Hive clear!</h1>
      <p class="tagline">Level ${levelId} complete in ${pourCount} — every stack is pure.</p>
    `;
    const actions = div('home-actions');
    if (next <= LEVEL_COUNT) {
      actions.append(
        button(`Next — Level ${next}`, 'btn block', () => startLevel(next)),
      );
    } else {
      actions.append(
        button('All 40 clear — Replay', 'btn block', () => startLevel(1)),
      );
    }
    actions.append(
      button('Share', 'btn gold block', () => shareWin()),
      button('Levels', 'btn secondary block', () => setScreen('levels')),
      button('Home', 'btn ghost block', () => setScreen('home')),
    );
    el.win.append(hero, actions);
  }

  // boot — first-run howto once, then Home (+ A2HS OK after dismiss)
  setScreen('home');
  if (!isHowtoSeen()) {
    openHowto(true);
  }
}

function div(className: string, id?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  if (id) d.id = id;
  return d;
}

function button(
  label: string,
  className: string,
  onClick: () => void,
  accessibleName?: string,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.type = 'button';
  if (accessibleName) b.setAttribute('aria-label', accessibleName);
  b.addEventListener('click', onClick);
  return b;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function focusDialog(modal: HTMLElement): void {
  const controls = Array.from(
    modal.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first || !last) return;
  modal.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  first.focus();
}

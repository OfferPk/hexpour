/**
 * HexPour UI — Home, level select, play, win; mute/settings; ads wired.
 */
import {
  cloneBoard,
  hintPour,
  isWon,
  loadBoard,
  tryPour,
} from '../game/engine';
import {
  loadPersist,
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
  setInterstitialPresenter,
  setRewardedPresenter,
  showInterstitial,
  showRewarded,
} from '../ads/stubs';

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

  const el = {
    home: div('screen', 'home'),
    levels: div('screen', 'levels'),
    play: div('screen', 'play'),
    win: div('screen', 'win'),
    overlay: div('overlay'),
    toast: div('toast'),
  };

  root.append(el.home, el.levels, el.play, el.win, el.overlay, el.toast);

  // —— Ad presenters (visible stubs) ——
  setInterstitialPresenter(async (reason) => {
    await showModalStub(
      'Ad stub — Interstitial',
      `Reason: ${reason}\n(No real ad SDK in MVP)`,
      'Continue',
    );
  });
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
    setTimeout(() => el.toast.classList.remove('show'), 1600);
  }

  function showModalStub(
    title: string,
    body: string,
    okLabel: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      el.overlay.className = 'overlay open';
      el.overlay.innerHTML = '';
      const modal = div('modal');
      modal.innerHTML = `<div class="ad-stub"><strong>${esc(title)}</strong>${esc(body).replace(/\n/g, '<br/>')}</div>`;
      const btn = button(okLabel, 'btn block', () => {
        el.overlay.className = 'overlay';
        el.overlay.innerHTML = '';
        resolve();
      });
      modal.append(btn);
      el.overlay.append(modal);
    });
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
    });
  }

  function setScreen(s: Screen): void {
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
      button('Settings', 'btn ghost block', () => openSettings()),
    );
    el.home.append(hero, actions);
  }

  function openSettings(): void {
    el.overlay.className = 'overlay open';
    el.overlay.innerHTML = '';
    const modal = div('modal');
    const h = document.createElement('h2');
    h.textContent = 'Settings';
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
  }

  // —— LEVELS ——
  function renderLevels(): void {
    persist = loadPersist();
    el.levels.innerHTML = '';
    const top = div('topbar');
    top.append(
      button('←', 'btn ghost', () => setScreen('home')),
      Object.assign(document.createElement('div'), {
        className: 'title',
        textContent: 'Select level',
      }),
      button(persist.mute ? '🔇' : '🔊', 'btn ghost', () => {
        persist = savePersist({ mute: !persist.mute });
        renderLevels();
      }),
    );
    const grid = div('level-grid');
    for (let i = 1; i <= LEVEL_COUNT; i++) {
      const locked = i > persist.unlocked;
      const done = i < persist.unlocked;
      const b = document.createElement('button');
      b.className = 'level-btn' + (locked ? ' locked' : '') + (done ? ' done' : '');
      b.textContent = locked ? '🔒' : String(i);
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
    el.play.innerHTML = '';
    const top = div('topbar');
    top.append(
      button('←', 'btn ghost', () => setScreen('levels')),
      Object.assign(document.createElement('div'), {
        className: 'title',
        textContent: `Level ${levelId}`,
      }),
      button('⚙', 'btn ghost', () => openSettings()),
    );
    const wrap = div('play-canvas-wrap');
    canvas = document.createElement('canvas');
    wrap.append(canvas);
    ctx = canvas.getContext('2d')!;

    const tools = div('toolbar');
    tools.append(
      button('Undo', 'btn secondary', () => doUndo()),
      button('Hint', 'btn secondary', () => void doHint()),
      button('Restart', 'btn ghost', () => void doRestart()),
    );
    el.play.append(top, wrap, tools);

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
        return;
      }
      const cell = board.cells.get(`${hit.q},${hit.r}`);
      if (!cell || cell.blocked) {
        selected = null;
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
        return;
      }
      if (selected.q === hit.q && selected.r === hit.r) {
        selected = null;
        return;
      }
      // attempt pour
      undoStack.push(cloneBoard(board));
      const result = tryPour(board, selected, hit);
      if (!result.ok) {
        undoStack.pop();
        pulseShake(hit);
        showToast(pourMsg(result.reason));
        selected = null;
        return;
      }
      selected = null;
      hint = null;
      if (isWon(board)) {
        void onWin();
      }
    };
    canvas.addEventListener('pointerup', onPointer);
  }

  function pulseShake(a: Axial): void {
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
    showToast('Hint highlighted');
  }

  async function doRestart(): Promise<void> {
    await showInterstitial('restart');
    startLevel(levelId);
  }

  async function onWin(): Promise<void> {
    const next = levelId + 1;
    if (next <= LEVEL_COUNT) {
      persist = unlockLevel(next);
    } else {
      // all done — keep unlocked at 40
      persist = unlockLevel(LEVEL_COUNT);
    }
    await showInterstitial('win');
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
    hero.innerHTML = `
      <h1>Hive clear!</h1>
      <p class="tagline">Level ${levelId} complete — every stack is pure.</p>
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
      button('Levels', 'btn secondary block', () => setScreen('levels')),
      button('Home', 'btn ghost block', () => setScreen('home')),
    );
    el.win.append(hero, actions);
  }

  // boot
  setScreen('home');
}

function div(className: string, id?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  if (id) d.id = id;
  return d;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.type = 'button';
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

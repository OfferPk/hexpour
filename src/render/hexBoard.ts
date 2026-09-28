/**
 * Canvas hex board renderer — flat-top axial.
 * Soft hive theme: warm greens, cream cells, rounded stacks.
 */
import { axialToPixel, hexCorners, pixelToAxial } from '../game/hex';
import { getCell, topColor } from '../game/engine';
import {
  COLOR_HEX,
  cellKey,
  type Axial,
  type BoardState,
  type ColorId,
} from '../game/types';

export interface RenderSelection {
  selected: Axial | null;
  hint: { from: Axial; to: Axial } | null;
  shakeKey: string | null;
  shakeUntil: number;
}

export interface BoardLayout {
  size: number;
  originX: number;
  originY: number;
}

export function computeLayout(
  board: BoardState,
  canvasW: number,
  canvasH: number,
  pad = 16,
): BoardLayout {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  const probe = 20;
  for (const c of board.cells.values()) {
    const { x, y } = axialToPixel(c.q, c.r, probe);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const bw = maxX - minX + 2 * probe;
  const bh = maxY - minY + 2 * probe;
  const size = Math.min((canvasW - pad * 2) / (bw / probe), (canvasH - pad * 2) / (bh / probe));
  const { x: cx0, y: cy0 } = axialToPixel(0, 0, size);
  // Recenter: map board centroid to canvas center
  let sx = 0,
    sy = 0,
    n = 0;
  for (const c of board.cells.values()) {
    const p = axialToPixel(c.q, c.r, size);
    sx += p.x;
    sy += p.y;
    n++;
  }
  const ox = canvasW / 2 - sx / n;
  const oy = canvasH / 2 - sy / n;
  void cx0;
  void cy0;
  return { size, originX: ox, originY: oy };
}

export function hitTest(
  board: BoardState,
  layout: BoardLayout,
  px: number,
  py: number,
): Axial | null {
  const localX = px - layout.originX;
  const localY = py - layout.originY;
  const a = pixelToAxial(localX, localY, layout.size);
  const cell = getCell(board, a.q, a.r);
  if (!cell) return null;
  // Distance check to hex center
  const { x, y } = axialToPixel(a.q, a.r, layout.size);
  const dx = localX - x;
  const dy = localY - y;
  if (Math.hypot(dx, dy) > layout.size * 0.95) return null;
  return a;
}

function drawHexPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void {
  const corners = hexCorners(cx, cy, size);
  ctx.beginPath();
  corners.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
}

export function drawBoard(
  ctx: CanvasRenderingContext2D,
  board: BoardState,
  layout: BoardLayout,
  sel: RenderSelection,
  now = performance.now(),
): void {
  const { size, originX, originY } = layout;

  for (const cell of board.cells.values()) {
    const { x, y } = axialToPixel(cell.q, cell.r, size);
    const cx = originX + x;
    const cy = originY + y;
    const key = cellKey(cell.q, cell.r);

    let shakeX = 0;
    if (sel.shakeKey === key && now < sel.shakeUntil) {
      shakeX = Math.sin(now / 30) * 4;
    }

    const hx = cx + shakeX;

    if (cell.blocked) {
      drawHexPath(ctx, hx, cy, size * 0.92);
      ctx.fillStyle = '#2a3d2a';
      ctx.fill();
      ctx.strokeStyle = '#1a281a';
      ctx.lineWidth = 2;
      ctx.stroke();
      // hole hatch
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      for (let i = -size; i < size; i += 6) {
        ctx.beginPath();
        ctx.moveTo(hx + i, cy - size);
        ctx.lineTo(hx + i + size, cy + size);
        ctx.stroke();
      }
      ctx.restore();
      continue;
    }

    // Cell body — soft cream / hive
    drawHexPath(ctx, hx, cy, size * 0.95);
    const isSel =
      sel.selected && sel.selected.q === cell.q && sel.selected.r === cell.r;
    const isHintFrom =
      sel.hint && sel.hint.from.q === cell.q && sel.hint.from.r === cell.r;
    const isHintTo =
      sel.hint && sel.hint.to.q === cell.q && sel.hint.to.r === cell.r;

    ctx.fillStyle = isSel ? '#fff6d8' : isHintFrom || isHintTo ? '#e8f8e0' : '#f5ecd8';
    ctx.fill();
    ctx.strokeStyle = isSel
      ? '#c9a227'
      : isHintFrom
        ? '#5cb85c'
        : isHintTo
          ? '#3d9e3d'
          : '#c4b89a';
    ctx.lineWidth = isSel || isHintFrom || isHintTo ? 3 : 1.5;
    ctx.stroke();

    // Stack tokens bottom → top as small rounded rects / pills
    const stack = cell.stack;
    const maxSlots = board.capacity;
    const tokenH = size * 0.22;
    const tokenW = size * 0.55;
    const gap = 2;
    const totalH = maxSlots * tokenH + (maxSlots - 1) * gap;
    let ty = cy + totalH / 2 - tokenH / 2;

    // empty slot guides
    for (let i = 0; i < maxSlots; i++) {
      const yy = ty - i * (tokenH + gap);
      ctx.beginPath();
      roundRect(ctx, hx - tokenW / 2, yy - tokenH / 2, tokenW, tokenH, 4);
      ctx.fillStyle = 'rgba(0,0,0,0.06)';
      ctx.fill();
    }

    for (let i = 0; i < stack.length; i++) {
      const color = stack[i] as ColorId;
      const yy = ty - i * (tokenH + gap);
      ctx.beginPath();
      roundRect(ctx, hx - tokenW / 2, yy - tokenH / 2, tokenW, tokenH, 5);
      ctx.fillStyle = COLOR_HEX[color];
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // gloss
      ctx.beginPath();
      roundRect(
        ctx,
        hx - tokenW / 2 + 2,
        yy - tokenH / 2 + 2,
        tokenW - 4,
        tokenH * 0.35,
        3,
      );
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fill();
    }

    // Uniform badge
    if (stack.length > 0) {
      const t = topColor(cell)!;
      const uniform = stack.every((c) => c === t);
      if (uniform && stack.length === board.capacity) {
        ctx.beginPath();
        ctx.arc(hx + size * 0.55, cy - size * 0.55, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#5cb85c';
        ctx.fill();
      }
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

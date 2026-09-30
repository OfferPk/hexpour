import { describe, expect, it } from 'vitest';
import {
  createCanvasResizeHandler,
  observeElementResize,
} from '../src/ui/canvasViewport';

describe('responsive canvas sizing', () => {
  it('matches a changed flex content box and disconnects its observer on cleanup', () => {
    const contentBox = { width: 330, height: 430 };
    const container = {
      get clientWidth() { return contentBox.width; },
      get clientHeight() { return contentBox.height; },
    };
    const element = container as unknown as Element;
    const canvas = {
      width: 0,
      height: 0,
      style: { width: '', height: '' },
    };
    const transforms: number[][] = [];
    const redrawSizes: Array<{
      width: number;
      height: number;
      backingWidth: number;
      backingHeight: number;
    }> = [];
    const context = {
      setTransform: (...values: number[]) => transforms.push(values),
    };
    const resize = createCanvasResizeHandler(
      container,
      canvas,
      context,
      () => 2,
      (width, height) => redrawSizes.push({
        width,
        height,
        backingWidth: canvas.width,
        backingHeight: canvas.height,
      }),
    );

    let observed: Element | null = null;
    let disconnected = false;
    let triggerResize: (() => void) | undefined;
    const disconnect = observeElementResize(element, resize, (callback) => {
      triggerResize = callback;
      return {
        observe: (target) => { observed = target; },
        disconnect: () => { disconnected = true; },
      };
    });

    expect(observed).toBe(element);
    resize();
    expect(canvas.width).toBe(660);
    expect(canvas.height).toBe(860);
    expect(canvas.style).toEqual({ width: '330px', height: '430px' });

    contentBox.height = 252;
    triggerResize?.();

    expect(canvas.width).toBe(660);
    expect(canvas.height).toBe(504);
    expect(canvas.style.height).toBe('252px');
    expect(redrawSizes).toEqual([
      { width: 330, height: 430, backingWidth: 660, backingHeight: 860 },
      { width: 330, height: 252, backingWidth: 660, backingHeight: 504 },
    ]);
    expect(transforms).toEqual([
      [2, 0, 0, 2, 0, 0],
      [2, 0, 0, 2, 0, 0],
    ]);

    disconnect();
    expect(disconnected).toBe(true);
  });
});

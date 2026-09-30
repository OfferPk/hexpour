export interface CanvasContainer {
  /** Drawable content-box size, excluding the wrapper's border. */
  clientWidth: number;
  clientHeight: number;
}

export interface CanvasSurface {
  width: number;
  height: number;
  style: { width: string; height: string };
}

export interface CanvasTransformContext {
  setTransform(
    scaleX: number,
    skewX: number,
    skewY: number,
    scaleY: number,
    translateX: number,
    translateY: number,
  ): void;
}

export function createCanvasResizeHandler(
  container: CanvasContainer,
  canvas: CanvasSurface,
  context: CanvasTransformContext,
  getDevicePixelRatio: () => number,
  onSize: (width: number, height: number) => void,
): () => void {
  return () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    const dpr = Math.min(getDevicePixelRatio() || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    onSize(width, height);
  };
}

export type CanvasResizeObserverFactory = (
  callback: () => void,
) => Pick<ResizeObserver, 'observe' | 'disconnect'>;

export function observeElementResize(
  element: Element,
  callback: () => void,
  createObserver: CanvasResizeObserverFactory = (onResize) =>
    new ResizeObserver(() => onResize()),
): () => void {
  const observer = createObserver(callback);
  observer.observe(element);
  return () => observer.disconnect();
}

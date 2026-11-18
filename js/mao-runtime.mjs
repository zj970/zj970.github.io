import { Container, Ticker, WebGLRenderer } from 'pixi.js';

let corePromise;
function loadCore() {
  if (globalThis.Live2DCubismCore) return Promise.resolve();
  if (!corePromise) corePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/live2d/mao/vendor/live2dcubismcore.min.js';
    script.onload = () => {
      script.remove();
      if (globalThis.Live2DCubismCore) resolve();
      else reject(new Error('Cubism Core unavailable'));
    };
    script.onerror = () => { script.remove(); reject(new Error('Cubism Core failed to load')); };
    document.head.appendChild(script);
  }).catch(error => { corePromise = null; throw error; });
  return corePromise;
}

// Ownership is returned immediately, including during Core/Pixi/model loading.
export function createMao({ canvas, width, height, resolution, onError }) {
  let renderer, context, stage, ticker, sprite, initializing = false, disposed = false, active = false, loaded = false;
  let motionIndex = 0, expressionIndex = 0;
  let Priority;
  const abort = new AbortController();
  const stop = () => { if (ticker) ticker.stop(); };
  // Partial Pixi system destruction may throw. Every independently owned resource
  // must still be released, and cleanup must not mask the original init error.
  const release = fn => { try { fn(); } catch (_) { /* continue independent cleanup */ } };
  const cleanup = () => {
    if (ticker) { const owned = ticker; ticker = null; release(() => owned.destroy()); }
    if (sprite) { const owned = sprite; sprite = null; release(() => owned.destroy()); }
    if (stage) { const owned = stage; stage = null; release(() => owned.destroy({ children: true })); }
    // Never destroy systems while their asynchronous init is still mutating them.
    if (initializing) return;
    if (renderer) { const owned = renderer; renderer = null; release(() => owned.destroy({ removeView: false, releaseGlobalResources: false })); }
    if (context) {
      const owned = context; context = null;
      release(() => { if (!owned.isContextLost()) owned.getExtension('WEBGL_lose_context')?.loseContext(); });
    }
  };
  const destroy = () => {
    if (disposed) return;
    disposed = true; abort.abort(); cleanup();
  };
  const loading = (async () => {
    await loadCore();
    if (disposed) return;
    // Framework evaluates Core constants at module scope, before sprite creation.
    const { Config, Live2DSprite, Priority: motionPriority } = await import('easy-live2d');
    Priority = motionPriority;
    if (disposed) return;
    Config.MotionGroupIdle = 'Idle'; Config.MouseFollow = false; Config.MotionSound = false;
    // Leave room for all six TapBody motions, including their full-size effects.
    Config.ViewScale = 0.78; Config.DebugLogEnable = false;
    context = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, stencil: true, antialias: false });
    if (!context) throw new Error('Mao requires WebGL 2');
    renderer = new WebGLRenderer();
    initializing = true;
    try {
      await renderer.init({ canvas, context, width, height, backgroundAlpha: 0, autoDensity: true, resolution });
    } finally {
      initializing = false;
      if (disposed) cleanup();
    }
    if (disposed) { cleanup(); return; }
    stage = new Container(); ticker = new Ticker();
    const render = () => renderer.render({ container: stage });
    ticker.add(() => {
      if (disposed || !active) return;
      try { render(); } catch (error) { destroy(); onError(error); }
    });
    sprite = new Live2DSprite({ modelPath: '/live2d/mao/Mao.model3.json', draggable: false });
    sprite.width = width; sprite.height = height; stage.addChild(sprite);
    sprite.onLive2D('error', error => { if (!disposed) { destroy(); onError(error); } });
    const modelReady = sprite.ready;
    // renderFrame is asynchronous: a stopped ticker must still initiate loading.
    render();
    await modelReady;
    if (disposed) return;
    loaded = true;
    render(); // Explicit static first frame, even under reduced motion.
    if (active) ticker.start();
    sprite.onLive2D('hit', () => { if (active && !disposed) void handle.motion().catch(() => {}); });
  })();
  // Abort settles ready even if Core/renderer.init remains in flight.
  const cancelled = new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('Mao disposed')), { once: true }));
  const timeout = setTimeout(() => { if (!disposed && !loaded) { destroy(); onError(new Error('Mao load timed out')); } }, 30000);
  const ready = Promise.race([loading, cancelled]).catch(error => { destroy(); throw error; }).finally(() => clearTimeout(timeout));
  void ready.catch(() => {});
  const handle = {
    ready, destroy,
    setActive(value) {
      active = Boolean(value) && !disposed;
      if (!loaded || disposed) return;
      if (active) ticker.start();
      else { stop(); handle.look({ x: 0, y: 0 }); }
    },
    look({ x, y }) {
      if (!loaded || disposed) return;
      sprite.setParameterValueById('ParamAngleX', x * 15); sprite.setParameterValueById('ParamAngleY', y * 10);
      sprite.setParameterValueById('ParamEyeBallX', x); sprite.setParameterValueById('ParamEyeBallY', y);
    },
    motion() {
      if (!active || !loaded || disposed) return Promise.resolve();
      return sprite.startMotion({ group: 'TapBody', no: motionIndex++ % 6, priority: Priority.Normal });
    },
    expression() {
      if (active && loaded && !disposed) sprite.setExpression({ expressionId: 'exp_' + String(expressionIndex++ % 8 + 1).padStart(2, '0') });
    }
  };
  return handle;
}

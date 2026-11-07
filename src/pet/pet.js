/**
 * Pet window script (bundled, no build step). Talks to the main process only
 * through `window.petBridge` (pet-preload.cjs). Renders `pet:render`
 * payloads by setting CSS custom properties via CSSOM (the page CSP allows no
 * inline styles) and turns pointer input into pet:* events. A duo payload
 * (`second` + `box.second`) shows #second beside #pet in the same state.
 */
'use strict';

(() => {
  const bridge = window.petBridge;
  const pet = document.getElementById('pet');
  const second = document.getElementById('second');
  const bubble = document.getElementById('bubble');
  if (!bridge || !pet || !second || !bubble) return;
  const sprites = [pet, second];

  const COLUMNS = 8;
  const CLICK_SLOP_PX = 4;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /** Atlas URL currently set per element. */
  const atlasUrls = new Map();
  let playKey = null;
  let duoShown = false;

  const px = (n) => `${Math.round(Number(n) || 0)}px`;

  /** Restart the CSS animations together (a new one-shot of the same state). */
  function restartAnimation() {
    for (const el of sprites) el.classList.remove('animate');
    void pet.offsetWidth;
    for (const el of sprites) if (!el.hidden) el.classList.add('animate');
  }

  /** Only our sprite protocol; anything else shows nothing. */
  const assetUrl = (atlas) =>
    typeof atlas?.url === 'string' && atlas.url.startsWith('pet-asset://')
      ? atlas.url
      : null;

  /**
   * One sprite element's geometry, row and atlas.
   * @param {HTMLElement} el
   * @param {any} payload
   * @param {any} atlas
   * @param {{ left: number, top: number }} at
   */
  function applySprite(el, payload, atlas, at) {
    const { box } = payload;
    const style = el.style;
    const fw = box.spriteWidth;
    const fh = box.spriteHeight;
    style.setProperty('--frame-w', px(fw));
    style.setProperty('--frame-h', px(fh));
    style.setProperty('--sheet-w', px(COLUMNS * fw));
    style.setProperty('--sheet-h', px((atlas?.rows || 9) * fh));
    style.setProperty('--sprite-left', px(at.left));
    style.setProperty('--sprite-top', px(at.top));
    style.setProperty(
      '--row',
      String(Math.max(0, Math.trunc(payload.row) || 0))
    );
    style.setProperty(
      '--frames',
      String(Math.max(2, Math.trunc(payload.frames) || 2))
    );
    style.setProperty(
      '--duration',
      `${Math.max(100, Math.trunc(payload.durationMs) || 1000)}ms`
    );

    const url = assetUrl(atlas);
    if (url !== (atlasUrls.get(el) ?? null)) {
      atlasUrls.set(el, url);
      style.backgroundImage = url
        ? `url("${url.replace(/["\\\n]/g, '')}")`
        : 'none';
    }
    el.classList.toggle('once', Boolean(payload.once));
  }

  function render(payload) {
    if (!payload || typeof payload !== 'object' || !payload.box) return;
    const { box } = payload;
    applySprite(pet, payload, payload.atlas, {
      left: box.spriteLeft,
      top: box.spriteTop
    });
    const duo = Boolean(payload.second && box.second);
    second.hidden = !duo;
    if (duo) applySprite(second, payload, payload.second, box.second);

    if (payload.still) {
      for (const el of sprites) el.classList.remove('animate');
    } else if (
      payload.playKey !== playKey ||
      duo !== duoShown ||
      !pet.classList.contains('animate')
    ) {
      restartAnimation();
    }
    playKey = payload.playKey;
    duoShown = duo;

    const text = typeof payload.bubble === 'string' ? payload.bubble : '';
    bubble.textContent = text;
    bubble.hidden = text.length === 0 || !box.bubble;
    bubble.classList.toggle('above', box.bubble === 'above');
    bubble.classList.toggle('below', box.bubble === 'below');
  }

  bridge.onRender(render);

  // --- Pointer input → pet:* events (either sprite of a duo) ---

  /** @type {null | { el: HTMLElement, id: number, startX: number, startY: number, lastX: number, lastY: number, moved: boolean, dx: number, dy: number, frame: number }} */
  let drag = null;

  function flushDrag() {
    if (!drag) return;
    drag.frame = 0;
    if (drag.dx !== 0 || drag.dy !== 0) {
      bridge.drag(drag.dx, drag.dy);
      drag.dx = 0;
      drag.dy = 0;
    }
  }

  function endPointer(event, cancelled) {
    if (!drag || event.pointerId !== drag.id) return;
    const ended = drag;
    if (ended.frame) cancelAnimationFrame(ended.frame);
    flushDrag();
    drag = null;
    ended.el.classList.remove('dragging');
    if (ended.moved) bridge.dragEnd();
    else if (!cancelled) bridge.click();
  }

  for (const el of sprites) {
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || drag) return;
      el.setPointerCapture(event.pointerId);
      drag = {
        el,
        id: event.pointerId,
        startX: event.screenX,
        startY: event.screenY,
        lastX: event.screenX,
        lastY: event.screenY,
        moved: false,
        dx: 0,
        dy: 0,
        frame: 0
      };
    });

    el.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (event.buttons === 0) {
        endPointer(event, true);
        return;
      }
      if (!drag.moved) {
        const far =
          Math.abs(event.screenX - drag.startX) >= CLICK_SLOP_PX ||
          Math.abs(event.screenY - drag.startY) >= CLICK_SLOP_PX;
        if (!far) return;
        drag.moved = true;
        el.classList.add('dragging');
      }
      drag.dx += event.screenX - drag.lastX;
      drag.dy += event.screenY - drag.lastY;
      drag.lastX = event.screenX;
      drag.lastY = event.screenY;
      // Coalesce to one IPC message per frame while dragging.
      if (!drag.frame) drag.frame = requestAnimationFrame(flushDrag);
    });

    el.addEventListener('pointerup', (event) => endPointer(event, false));
    el.addEventListener('pointercancel', (event) => endPointer(event, true));
    // X11/XWayland can drop the release while the window moves under the
    // pointer: also end on lost capture, a buttonless move, or window blur.
    el.addEventListener('lostpointercapture', (event) =>
      endPointer(event, true)
    );
    el.addEventListener('dblclick', () => bridge.dblclick());
    el.addEventListener('pointerenter', () => {
      if (!drag) bridge.hover();
    });
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      bridge.contextMenu();
    });
  }
  window.addEventListener('blur', () => {
    if (drag) endPointer({ pointerId: drag.id }, true);
  });

  bubble.addEventListener('click', () => bridge.bubbleClick());

  const reportMotion = () => bridge.ready({ reducedMotion: motion.matches });
  motion.addEventListener('change', reportMotion);
  reportMotion();
})();

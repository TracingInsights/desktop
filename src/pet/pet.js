/**
 * Pet window script (bundled, no build step). Talks to the main process only
 * through `window.petBridge` (pet-preload.cjs). Renders `pet:render`
 * payloads by setting CSS custom properties via CSSOM (the page CSP allows no
 * inline styles) and turns pointer input into pet:* events. A duo payload
 * (`second` + `box.second`) shows #second beside #pet in the same state, or
 * in its own `secondAnim` (4b duo reactions). While `sleeping` (2b) a "z z"
 * mark (#zzz, created here) floats beside the first sprite's head.
 *
 * Round 3: buttons under the bubble (`bubbleActions` → pet:bubbleAction),
 * the click panel (`panel` + `box.panel` → pet:panelAction; Escape, losing
 * focus or PANEL_IDLE_MS without the pointer inside send `close`) and the
 * "Answer ready" badge (`badge`, a dot at the pet's top-right).
 */
'use strict';

(() => {
  const bridge = window.petBridge;
  const pet = document.getElementById('pet');
  const second = document.getElementById('second');
  const bubble = document.getElementById('bubble');
  if (!bridge || !pet || !second || !bubble) return;
  const sprites = [pet, second];
  // Round 3 elements (each optional: the pet works without them).
  const bubbleText = document.getElementById('bubble-text');
  const bubbleActions = document.getElementById('bubble-actions');
  const panel = document.getElementById('panel');
  const panelLines = document.getElementById('panel-lines');
  const panelActions = document.getElementById('panel-actions');
  const badge = document.getElementById('badge');
  const badgeText = document.getElementById('badge-text');

  const COLUMNS = 8;
  const CLICK_SLOP_PX = 4;
  /** PANEL_IDLE_MS in pets/contract.mjs. */
  const PANEL_IDLE_MS = 20 * 1000;
  /** Panel ↔ sprite gap (the window margin pet-window.mjs reserves). */
  const PANEL_GAP_PX = 4;
  const BADGE_PX = 14;
  /**
   * Badge top, × sprite height: under the sleep "z z" mark (0.08 × height +
   * its font + float, see applySleep), so the two never overlap.
   */
  const BADGE_TOP = 0.25;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /** Atlas URL currently set per element. */
  const atlasUrls = new Map();
  /** Per sprite: the playKey + row it plays (a change restarts it). */
  const playKeys = new Map();
  let duoShown = false;

  const px = (n) => `${Math.round(Number(n) || 0)}px`;

  // Sleep (round 3): a "z z" mark beside the head while `payload.sleeping`.
  const zzz = document.createElement('div');
  zzz.id = 'zzz';
  zzz.textContent = 'z z';
  zzz.setAttribute('aria-hidden', 'true');
  zzz.hidden = true;
  document.body.append(zzz);

  /**
   * Show / place the "z z" mark (the sprite is a still frame meanwhile; the
   * mark floats in CSS unless reduced motion). Absent `sleeping` = awake.
   * @param {any} payload
   */
  function applySleep(payload) {
    const asleep = payload.sleeping === true;
    zzz.hidden = !asleep;
    pet.setAttribute(
      'aria-label',
      asleep ? 'Desktop pet, asleep' : 'Desktop pet'
    );
    if (!asleep) return;
    const { box } = payload;
    const style = zzz.style;
    style.setProperty(
      '--zzz-left',
      px(box.spriteLeft + box.spriteWidth * 0.64)
    );
    style.setProperty('--zzz-top', px(box.spriteTop + box.spriteHeight * 0.08));
    style.setProperty('--zzz-size', px(Math.max(10, box.spriteHeight * 0.1)));
  }

  /**
   * Restart the CSS animations of `els` together (a new one-shot of the
   * same state); the other sprite keeps its phase.
   * @param {HTMLElement[]} els
   */
  function restartAnimation(els) {
    if (els.length === 0) return;
    for (const el of els) el.classList.remove('animate');
    void pet.offsetWidth;
    for (const el of els) if (!el.hidden) el.classList.add('animate');
  }

  /** Duo (4b): the second sprite's own animation, or null = the first's. */
  const ownAnim = (anim) =>
    anim && typeof anim === 'object' && Number.isFinite(anim.row) ? anim : null;

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
   * @param {any} [anim] row, frames, duration, once, delay (default: payload)
   */
  function applySprite(el, payload, atlas, at, anim = payload) {
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
    style.setProperty('--row', String(Math.max(0, Math.trunc(anim.row) || 0)));
    style.setProperty(
      '--frames',
      String(Math.max(2, Math.trunc(anim.frames) || 2))
    );
    style.setProperty(
      '--duration',
      `${Math.max(100, Math.trunc(anim.durationMs) || 1000)}ms`
    );
    style.setProperty(
      '--delay',
      `${Math.min(10_000, Math.max(0, Math.trunc(anim.delayMs) || 0))}ms`
    );

    const url = assetUrl(atlas);
    if (url !== (atlasUrls.get(el) ?? null)) {
      atlasUrls.set(el, url);
      style.backgroundImage = url
        ? `url("${url.replace(/["\\\n]/g, '')}")`
        : 'none';
    }
    el.classList.toggle('once', Boolean(anim.once));
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
    // Duo reactions (4b): the second sprite may play its own animation.
    const secondAnim = ownAnim(payload.secondAnim) ?? payload;
    if (duo) {
      applySprite(second, payload, payload.second, box.second, secondAnim);
    }

    /** Sprites to restart together; the other one keeps its phase. */
    const restart = [];
    for (const [el, anim] of [
      [pet, payload],
      [second, secondAnim]
    ]) {
      if (el.hidden) continue;
      const key = `${anim.playKey}|${anim.row}`;
      if (anim.still) {
        el.classList.remove('animate');
      } else if (
        key !== playKeys.get(el) ||
        duo !== duoShown ||
        !el.classList.contains('animate')
      ) {
        restart.push(el);
      }
      playKeys.set(el, key);
    }
    restartAnimation(restart);
    duoShown = duo;
    applySleep(payload);

    const text = typeof payload.bubble === 'string' ? payload.bubble : '';
    if (bubbleText) bubbleText.textContent = text;
    else bubble.textContent = text;
    bubble.hidden = text.length === 0 || !box.bubble;
    bubble.classList.toggle('above', box.bubble === 'above');
    bubble.classList.toggle('below', box.bubble === 'below');
    if (bubbleActions) {
      renderActions(
        bubbleActions,
        bubble.hidden ? null : payload.bubbleActions,
        (id) => bridge.bubbleAction(id)
      );
    }
    renderPanel(payload);
    renderBadge(payload);
  }

  // --- Round 3: bubble buttons, click panel, answer badge ---

  /** Button rows as last built, so a re-render keeps focus. */
  const builtActions = new Map();

  /**
   * Fill a button row (rebuilt only when ids or labels change).
   * @param {HTMLElement} row
   * @param {unknown} actions
   * @param {(id: string) => void} onAction
   */
  function renderActions(row, actions, onAction) {
    const list = (Array.isArray(actions) ? actions : []).filter(
      (a) => a && typeof a.id === 'string' && typeof a.label === 'string'
    );
    const key = JSON.stringify(list.map((a) => [a.id, a.label]));
    if (builtActions.get(row) !== key) {
      builtActions.set(row, key);
      row.replaceChildren(
        ...list.map((action) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'pet-action';
          button.textContent = action.label;
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            onAction(action.id);
          });
          return button;
        })
      );
    }
    row.hidden = list.length === 0;
  }

  let panelShown = false;
  let pointerInside = false;
  let panelTimer = 0;

  /** Close the panel after PANEL_IDLE_MS with the pointer outside the window. */
  function armPanelTimer() {
    if (!panelShown || pointerInside) {
      if (panelTimer) clearTimeout(panelTimer);
      panelTimer = 0;
      return;
    }
    if (panelTimer) return;
    panelTimer = setTimeout(() => {
      panelTimer = 0;
      if (panelShown) bridge.panelAction('close');
    }, PANEL_IDLE_MS);
  }

  function renderPanel(payload) {
    if (!panel || !panelLines || !panelActions) return;
    const { box } = payload;
    const data =
      payload.panel && typeof payload.panel === 'object' && box.panel
        ? payload.panel
        : null;
    panel.hidden = !data;
    panel.classList.toggle('above', box.panel === 'above');
    panel.classList.toggle('below', box.panel === 'below');
    if (data) {
      // Anchored to the sprite side, so any spare estimated room stays outside.
      const edge =
        box.panel === 'above'
          ? box.height - box.spriteTop + PANEL_GAP_PX
          : box.spriteTop + box.spriteHeight + PANEL_GAP_PX;
      panel.style.setProperty('--panel-edge', px(edge));
      const lines = (Array.isArray(data.lines) ? data.lines : [])
        .filter((line) => typeof line === 'string' && line.length > 0)
        .slice(0, 3);
      panelLines.replaceChildren(
        ...lines.map((line) => {
          const p = document.createElement('p');
          p.className = 'panel-line';
          p.textContent = line;
          return p;
        })
      );
      panelLines.hidden = lines.length === 0;
      renderActions(panelActions, data.actions, (id) => bridge.panelAction(id));
    } else {
      renderActions(panelActions, null, () => {});
    }
    panelShown = Boolean(data);
    armPanelTimer();
  }

  function renderBadge(payload) {
    if (!badge) return;
    const { box } = payload;
    const data =
      payload.badge && typeof payload.badge.label === 'string'
        ? payload.badge
        : null;
    badge.hidden = !data;
    if (!data) return;
    const inset = Math.round(box.spriteWidth * 0.1);
    badge.style.setProperty(
      '--badge-left',
      px(box.spriteLeft + box.spriteWidth - BADGE_PX - inset)
    );
    badge.style.setProperty(
      '--badge-top',
      px(box.spriteTop + box.spriteHeight * BADGE_TOP)
    );
    badge.setAttribute('aria-label', data.label);
    badge.title = data.label;
    if (badgeText) badgeText.textContent = data.label;
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

  bubble.addEventListener('click', (event) => {
    // The button row is not the bubble text: only its buttons act.
    if (event.target instanceof Element && event.target.closest('.pet-actions'))
      return;
    bridge.bubbleClick();
  });

  // Panel: pointer inside the window keeps it open; Escape / blur close it.
  document.addEventListener('pointerover', () => {
    pointerInside = true;
    armPanelTimer();
  });
  document.addEventListener('pointerdown', () => {
    pointerInside = true;
    armPanelTimer();
  });
  document.addEventListener('pointerout', (event) => {
    if (event.relatedTarget) return;
    pointerInside = false;
    armPanelTimer();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !panelShown) return;
    event.preventDefault();
    bridge.panelAction('close');
  });
  window.addEventListener('blur', () => {
    if (panelShown) bridge.panelAction('close');
  });

  const reportMotion = () => bridge.ready({ reducedMotion: motion.matches });
  motion.addEventListener('change', reportMotion);
  reportMotion();
})();

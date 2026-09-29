/* ARIA tactile layer (behaviour half; styles live in tactile.css).
 *
 *   - Tags every button `.tac` (including ones app.js creates later) and gives
 *     it a pointer-origin press: `.is-pressed` + --press-x/--press-y while held,
 *     kept for a minimum beat so a quick click is still felt. Keyboard presses
 *     (Space/Enter) get the same feedback.
 *   - Keeps each Settings slider's filled track (--fill) in sync, including
 *     values app.js sets programmatically.
 *   - Drives the Settings nav: a single indicator that slides to the active tab,
 *     the per-tab description under the title, a scroll shadow under the header,
 *     and a footer hint saying whether the page needs Save.
 * Pure DOM; no IPC, no config. Safe to load after app.js. */
(function () {
  'use strict';
  const MIN_PRESS_MS = 110;
  // Load after ux.css (which app.js appends) so these rules refine both sheets.
  if (!document.querySelector('link[data-tactile]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = 'tactile.css'; link.dataset.tactile = '1';
    document.head.appendChild(link);
  }
  const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ── Press feedback ──
  function tag(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.tagName === 'BUTTON') root.classList.add('tac');
    root.querySelectorAll('button').forEach((b) => b.classList.add('tac'));
  }
  tag(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) tag(n);
  }).observe(document.body, { childList: true, subtree: true });

  let pressed = null;
  let pressedAt = 0;
  function release() {
    const el = pressed;
    if (!el) return;
    pressed = null;
    const left = MIN_PRESS_MS - (performance.now() - pressedAt);
    if (left > 0) setTimeout(() => { if (pressed !== el) el.classList.remove('is-pressed'); }, left);
    else el.classList.remove('is-pressed');
  }
  function press(el, x, y) {
    if (pressed && pressed !== el) pressed.classList.remove('is-pressed');
    const r = el.getBoundingClientRect();
    el.style.setProperty('--press-x', `${Math.round(x === undefined ? r.width / 2 : x - r.left)}px`);
    el.style.setProperty('--press-y', `${Math.round(y === undefined ? r.height / 2 : y - r.top)}px`);
    el.classList.add('is-pressed');
    pressed = el; pressedAt = performance.now();
  }
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const el = e.target.closest && e.target.closest('button.tac');
    if (!el || el.disabled) return;
    press(el, e.clientX, e.clientY);
  }, true);
  for (const t of ['pointerup', 'pointercancel', 'dragstart']) document.addEventListener(t, release, true);
  document.addEventListener('pointerout', (e) => { if (pressed && e.target === pressed && !pressed.contains(e.relatedTarget)) release(); }, true);
  document.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      const el = document.activeElement;
      if (el && el.matches && el.matches('button.tac') && !el.disabled) press(el);
    }
  }, true);
  document.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') release(); }, true);
  window.addEventListener('blur', release);

  // ── Slider fill ──
  const valueDesc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  function fill(el) {
    const min = Number(el.min || 0), max = Number(el.max || 100), v = Number(valueDesc.get.call(el));
    const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
    el.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`);
  }
  function wireRange(el) {
    if (el.dataset.tacFill) return;
    el.dataset.tacFill = '1';
    // Programmatic `el.value = …` (app.js repaints on open) must move the fill too.
    Object.defineProperty(el, 'value', {
      configurable: true,
      get() { return valueDesc.get.call(this); },
      set(v) { valueDesc.set.call(this, v); fill(this); },
    });
    el.addEventListener('input', () => fill(el));
    el.addEventListener('change', () => fill(el));
    fill(el);
  }
  document.querySelectorAll('input[type="range"]').forEach(wireRange);

  // ── Settings nav ──
  const overlay = document.getElementById('settings-overlay');
  const nav = document.getElementById('settings-nav');
  const body = document.querySelector('.settings-body');
  const content = document.querySelector('.settings-content');
  const desc = document.getElementById('settings-tab-desc');
  const footHint = document.getElementById('settings-footer-hint');
  // Tabs whose controls persist the moment they change (no Save needed).
  const INSTANT = new Set(['appearance', 'context', 'memory', 'updates']);
  let indicator = null;
  function placeIndicator(animate) {
    if (!nav || !indicator) return;
    const active = nav.querySelector('.snav-item.active');
    // Layout offsets, not getBoundingClientRect: the dialog is mid scale-in
    // when this first runs, and transformed rects would size the pill wrong.
    if (!active || !active.offsetWidth) return;
    indicator.classList.toggle('no-anim', !animate || reduced());
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.height = `${active.offsetHeight}px`;
    indicator.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    if (!animate) void indicator.offsetWidth; // commit the jump before re-enabling transitions
  }
  function syncHeader() {
    const active = nav && nav.querySelector('.snav-item.active');
    if (!active) return;
    if (desc) desc.textContent = active.dataset.desc || '';
    if (footHint) footHint.textContent = INSTANT.has(active.dataset.tab)
      ? 'Changes on this page apply instantly.' : 'Save to apply changes on this page.';
  }
  if (nav) {
    indicator = document.createElement('div');
    indicator.className = 'snav-indicator no-anim';
    indicator.setAttribute('aria-hidden', 'true');
    nav.insertBefore(indicator, nav.firstChild);
    nav.classList.add('has-indicator');
    // app.js owns which tab is active; follow its class changes.
    new MutationObserver(() => { placeIndicator(true); syncHeader(); })
      .observe(nav, { attributes: true, attributeFilter: ['class'], subtree: true });
    syncHeader();
  }
  if (overlay) {
    new MutationObserver(() => {
      if (!overlay.classList.contains('visible')) return;
      document.querySelectorAll('input[type="range"]').forEach(wireRange);
      requestAnimationFrame(() => placeIndicator(false));
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }
  window.addEventListener('resize', () => placeIndicator(false));
  if (content && body) {
    content.addEventListener('scroll', () => body.classList.toggle('is-scrolled', content.scrollTop > 4), { passive: true });
    if (nav) nav.addEventListener('click', () => body.classList.remove('is-scrolled'));
  }

  window.AriaTactile = { placeIndicator, fill };
})();

/* ARIA appearance: glass material + background scenes.
 *
 * Owns three things and nothing else:
 *   1. the CSS custom properties that drive the glass material (blur, tint,
 *      style) and the background dim, written on <html>;
 *   2. which background scene is shown (<html data-bg>);
 *   3. the user's custom background image, kept as a Blob in this renderer's
 *      IndexedDB so it never enters the JSON config or crosses IPC.
 *
 * Pure DOM + Web platform; no Node, no IPC. app.js persists the chosen values
 * through aria.config and calls apply() with them. */
(function () {
  'use strict';

  const BACKGROUNDS = [
    { id: 'obsidian', label: 'Obsidian' },
    { id: 'studio', label: 'Studio light' },
    { id: 'eclipse', label: 'Eclipse' },
    { id: 'aurora', label: 'Aurora' },
    { id: 'dusk', label: 'Dusk' },
    { id: 'ocean', label: 'Deep ocean' },
    { id: 'observatory', label: 'Observatory' },
    { id: 'solid', label: 'Solid' },
    { id: 'custom', label: 'Custom image' },
  ];
  const STYLES = ['smoked', 'frosted', 'clear'];
  const DEFAULTS = { background: 'obsidian', glassStyle: 'smoked', glassBlur: 26, glassOpacity: 30, bgDim: 0 };
  const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
  const ACCEPTED = /^image\/(png|jpeg|webp|gif|avif|bmp)$/;

  const DB_NAME = 'aria-appearance';
  const STORE = 'files';
  const KEY = 'custom-background';

  let customUrl = null; // current object URL for the custom image
  let current = { ...DEFAULTS };

  function clamp(n, lo, hi, fallback) {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  }

  function normalize(s) {
    const o = s || {};
    return {
      background: BACKGROUNDS.some((b) => b.id === o.background) ? o.background : DEFAULTS.background,
      glassStyle: STYLES.includes(o.glassStyle) ? o.glassStyle : DEFAULTS.glassStyle,
      glassBlur: clamp(o.glassBlur, 0, 60, DEFAULTS.glassBlur),
      glassOpacity: clamp(o.glassOpacity, 0, 100, DEFAULTS.glassOpacity),
      bgDim: clamp(o.bgDim, 0, 80, DEFAULTS.bgDim),
    };
  }

  // ── IndexedDB (one object store, one key) ──
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = window.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbOp(mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  const loadCustomBlob = () => dbOp('readonly', (s) => s.get(KEY)).catch(() => null);

  function setCustomUrl(blob) {
    if (customUrl) URL.revokeObjectURL(customUrl);
    customUrl = blob ? URL.createObjectURL(blob) : null;
    const el = document.getElementById('bg-custom');
    if (el) el.style.backgroundImage = customUrl ? `url("${customUrl}")` : '';
    document.documentElement.dataset.hasCustomBg = customUrl ? 'true' : 'false';
  }

  /** Validate and store an image File/Blob as the custom background. */
  async function setCustomImage(file) {
    if (!file) throw new Error('No file selected.');
    if (!ACCEPTED.test(file.type || '')) throw new Error('Use a PNG, JPEG, WebP, AVIF, GIF or BMP image.');
    if (file.size > MAX_IMAGE_BYTES) throw new Error('That image is over 25 MB. Pick a smaller one.');
    // Decode before storing so a corrupt file never becomes the saved background.
    const url = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = resolve;
        img.onerror = () => reject(new Error('That file could not be read as an image.'));
        img.src = url;
      });
    } finally { URL.revokeObjectURL(url); }
    const blob = new Blob([await file.arrayBuffer()], { type: file.type });
    await dbOp('readwrite', (s) => s.put(blob, KEY));
    setCustomUrl(blob);
    return true;
  }

  async function clearCustomImage() {
    await dbOp('readwrite', (s) => s.delete(KEY)).catch(() => {});
    setCustomUrl(null);
  }

  const hasCustomImage = () => !!customUrl;

  /** Apply a (partial) appearance state. Returns the normalized state. */
  function apply(state) {
    current = normalize({ ...current, ...(state || {}) });
    const root = document.documentElement;
    // A missing custom image falls back to the default scene instead of black.
    const bg = current.background === 'custom' && !customUrl ? DEFAULTS.background : current.background;
    root.dataset.bg = bg;
    root.dataset.glass = current.glassStyle;
    root.style.setProperty('--glass-blur', `${current.glassBlur}px`);
    root.style.setProperty('--glass-tint', String(current.glassOpacity / 100));
    root.style.setProperty('--bg-dim', String(current.bgDim / 100));
    return { ...current };
  }

  async function init(state) {
    const blob = await loadCustomBlob();
    if (blob) setCustomUrl(blob);
    return apply(state);
  }

  window.AriaAppearance = {
    BACKGROUNDS, STYLES, DEFAULTS, MAX_IMAGE_BYTES,
    normalize, apply, init, setCustomImage, clearCustomImage, hasCustomImage,
    get state() { return { ...current }; },
  };
})();

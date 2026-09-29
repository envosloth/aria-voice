/* Finish refinement only: preserve the real mic element and all PTT handlers. */
(() => {
  'use strict';
  const sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = 'liquid.css';
  document.head.appendChild(sheet);
  const mic = document.getElementById('mic-btn');
  if (!mic || mic.querySelector('.voice-wave')) return;
  const wave = document.createElement('span');
  wave.className = 'voice-wave';
  wave.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 5; i++) wave.appendChild(document.createElement('i'));
  const label = document.createElement('span');
  label.className = 'voice-key-label';
  label.textContent = 'Talk';
  label.setAttribute('aria-hidden', 'true');
  mic.replaceChildren(wave, label);
})();

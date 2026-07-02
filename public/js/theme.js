import { $ } from './core.js';

let themeMode = localStorage.getItem('notepad-theme') || 'auto';

function applyTheme() {
  if (themeMode === 'auto') {
    document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } else {
    document.documentElement.dataset.theme = themeMode;
  }
}

function toggleTheme() {
  const order = ['auto', 'dark', 'light'];
  themeMode = order[(order.indexOf(themeMode) + 1) % 3];
  if (themeMode === 'auto') localStorage.removeItem('notepad-theme');
  else localStorage.setItem('notepad-theme', themeMode);
  applyTheme();
}

export function initTheme() {
  applyTheme();
  $('#theme-toggle').addEventListener('click', toggleTheme);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeMode === 'auto') applyTheme();
  });
}

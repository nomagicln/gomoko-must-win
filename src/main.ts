/**
 * 应用入口。
 */

import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import './styles/views.css';

import { startApp } from './app';

function boot(): void {
  const root = document.getElementById('app');
  if (root) startApp(root);
  const splash = document.getElementById('boot');
  if (splash) {
    window.setTimeout(() => splash.setAttribute('hidden', ''), 220);
    window.setTimeout(() => splash.remove(), 1200);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

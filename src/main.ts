import './style.css';
import { mountApp } from './ui/app';
import { registerSW } from 'virtual:pwa-register';

const root = document.getElementById('app');
if (root) mountApp(root);

try {
  registerSW({ immediate: true });
} catch {
  /* vitest / non-PWA */
}

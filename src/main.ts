import './styles.css';
import { App } from './app.ts';

declare global {
  interface Window {
    /** exposed only with ?debug in the URL, for automated tests */
    __hp?: App;
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

const app = new App();
app.mount(root);
if (new URLSearchParams(location.search).has('debug')) window.__hp = app;

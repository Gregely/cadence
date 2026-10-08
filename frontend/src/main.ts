import '@fontsource/literata/400.css';
import '@fontsource/literata/400-italic.css';
import '@fontsource/literata/600.css';
import './styles/base.css';
import './styles/analogue.css';

import { App } from './app';

async function start(): Promise<void> {
  const root = document.getElementById('app')!;
  if (window.location.pathname === '/clip') {
    const { clipPage } = await import('./clip');
    await clipPage(root);
    return;
  }
  if (window.location.pathname === '/boox-test') {
    const { booxTest } = await import('./boox');
    booxTest(root);
    return;
  }
  const app = new App(root);
  const features = await import('./features/index');
  features.install(app);
  await app.boot();
  (window as unknown as { cadence?: App }).cadence = app;
}

void start();

if ('serviceWorker' in navigator && window.isSecureContext && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

// Entry for the hosted browser demo (Vercel). The local app's entry stays src/main.tsx.
import { Buffer } from 'buffer';
import { bootDemo, resetDemo } from './runtime';
import './demo.css';

const REPO_URL = 'https://github.com/AutomationofMrJ/billable';
(globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;

function banner() {
  const bar = document.createElement('aside');
  bar.className = 'hosted-demo-note';
  bar.setAttribute('aria-label', 'About this demo');
  bar.innerHTML = `<strong>Browser demo</strong><span>Fictional data. Everything stays in this browser.</span>
    <button type="button" data-reset>Reset demo</button><a href="${REPO_URL}" target="_blank" rel="noreferrer">Get the local app</a>
    <button type="button" class="demo-close" aria-label="Hide demo notice">×</button>`;
  bar.querySelector('[data-reset]')!.addEventListener('click', () => { if (confirm('Reset the demo? This removes your changes in this browser and reloads the sample studio.')) resetDemo(); });
  bar.querySelector('.demo-close')!.addEventListener('click', () => bar.remove());
  document.body.append(bar);
}

bootDemo()
  .then(() => import('../src/main'))
  .then(banner)
  .catch(error => {
    console.error(error);
    document.getElementById('root')!.innerHTML = '<p style="font:16px system-ui;padding:32px">The demo could not start in this browser. Try a current Chrome, Edge, Firefox or Safari, outside private mode.</p>';
  });

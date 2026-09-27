import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { DetachedDeepDive } from './shell/DetachedDeepDive.js';
import { store } from './lib/sync.js';
import './styles.css';
import './styles/desktop.css';

// A theme choice is a per-person convenience; dark is the default.
const theme = store.get('cot.theme.v1');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

// A detached Deep Dive window is the same renderer opened on one target.
const detached = new URLSearchParams(location.hash.slice(1)).get('detached');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {detached ? <DetachedDeepDive target={detached} /> : <App />}
  </StrictMode>,
);

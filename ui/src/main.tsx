import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { applyBrand } from './brand';
import './styles.css';
import { initManifold } from './kernel/ops/manifold';

// Start loading the boolean engine immediately. The worker loads its own copy; this one
// is for the fallback path that runs on this thread where a worker is unavailable.
void initManifold();

// Resolve product identity before first paint so the window title and header never
// flash the default name on a white-labelled build.
applyBrand();

/**
 * Theme: the panel follows the host. SOLIDWORKS users overwhelmingly run a dark or grey
 * UI against a light graphics area, so dark is the default and the OS preference only
 * switches us to light when it is explicitly set.
 */
const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
document.documentElement.setAttribute('data-theme', prefersLight ? 'light' : 'dark');

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

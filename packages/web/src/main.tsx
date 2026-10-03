import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// HK-47 fork (PERS-31): when the day's session expires, any API call answers
// 401. Send the page to /login once, wherever the call came from, instead of
// leaving every panel to fail on its own.
const nativeFetch = window.fetch.bind(window);
window.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
  const res = await nativeFetch(...args);
  if (res.status === 401 && window.location.pathname !== '/login') {
    const req = args[0];
    const raw = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url;
    const path = new URL(raw, window.location.origin).pathname;
    if (path.startsWith('/api/') && !path.startsWith('/api/auth/')) {
      window.location.assign('/login');
    }
  }
  return res;
}) as typeof fetch;

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

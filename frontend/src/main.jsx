import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

const isStaleAssetError = (error) => {
  const message = String(error?.message || error?.reason?.message || error?.reason || error || '');
  return (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Importing a module script failed') ||
    message.includes('valid JavaScript MIME type') ||
    message.includes('text/html') ||
    message.includes('module script')
  );
};

const reloadForFreshAssets = () => {
  const key = 'trader_core_asset_reload_at';
  const lastReload = Number(sessionStorage.getItem(key) || 0);
  if (Date.now() - lastReload < 10000) return;
  sessionStorage.setItem(key, String(Date.now()));
  window.location.reload();
};

window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  reloadForFreshAssets();
});

window.addEventListener('error', (event) => {
  if (isStaleAssetError(event.error || event.message)) {
    event.preventDefault();
    reloadForFreshAssets();
  }
});

window.addEventListener('unhandledrejection', (event) => {
  if (isStaleAssetError(event.reason)) {
    event.preventDefault();
    reloadForFreshAssets();
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
    // When a freshly installed/updated service worker takes control, reload once
    // so the page runs the newest bundle instead of a stale cached one.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (sessionStorage.getItem('trader_core_sw_updated') === 'yes') return;
      sessionStorage.setItem('trader_core_sw_updated', 'yes');
      window.location.reload();
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

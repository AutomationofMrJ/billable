import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import { initLanguage } from './i18n';
import { initTheme } from './theme';

initTheme();
// The interface modules read their text when they load, so the language is set before they are imported.
void initLanguage().then(async () => {
  const [{ default: App }, { ErrorBoundary }] = await Promise.all([import('./App'), import('./components')]);
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);
});

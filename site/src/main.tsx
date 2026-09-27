import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import App from './App';
import './styles/globals.css';
import './styles/layout.css';
import './styles/product-ui.css';
import './styles/skin.css';
import './styles/motion.css';
import './styles/responsive.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root mount element #root was not found.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

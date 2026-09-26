import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import './styles/layout.css';
import './styles/product-ui.css';
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

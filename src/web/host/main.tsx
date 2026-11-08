import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

const root = document.querySelector<HTMLDivElement>('#host-root');
if (!root) throw new Error('missing #host-root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

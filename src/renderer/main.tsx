import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { sweepStaleDrafts } from './lib/chat-drafts';
import { sweepStaleStaging } from './lib/prompt-staging';
import { initCloseFlushBridge } from './components/fileviewer/closeFlushBridge';
import 'katex/dist/katex.min.css';
import './styles/globals.css';

sweepStaleDrafts();
sweepStaleStaging();
// Edit-loss §4.3: answer main's close-flush requests in BOTH window flavors
// (shell and detached file windows) — registered at the entry so it exists
// regardless of which components are mounted.
initCloseFlushBridge();

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { sweepStaleDrafts } from './lib/chat-drafts';
import { sweepStaleStaging } from './lib/prompt-staging';
import 'katex/dist/katex.min.css';
import './styles/globals.css';

sweepStaleDrafts();
sweepStaleStaging();

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

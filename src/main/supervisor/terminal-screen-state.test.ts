import assert from 'node:assert/strict';
import { TerminalScreenState } from './terminal-screen-state';

const screen = new TerminalScreenState(120, 40);
screen.write('Welcome to the Antigravity CLI. You are currently not signed in.\r\nSigning in...');
assert.match(screen.render(), /currently not signed in/i);

screen.write('\x1b[2J\x1b[HAntigravity CLI\r\nuser@example.com\r\nReady');
assert.doesNotMatch(screen.render(), /currently not signed in/i);
assert.match(screen.render(), /user@example\.com/);

const persistent = new TerminalScreenState(120, 40);
persistent.write('\x1b[2J\x1b[HWelcome to the Antigravity CLI. You are currently not signed in.');
assert.match(persistent.render(), /currently not signed in/i);

console.log('terminal-screen-state: 3 assertions passed');

// WP5 — plan render-pane security decisions test.
//
// The pane's three script-blocking layers are asserted here at the decision
// level: hardened web preferences (JS off), a strict CSP with no script-src,
// and a data: document that carries both the CSP and the sanitized body.
//
//   npm run build:main
//   node dist/main/main/plans/plan-render-pane.test.js

import assert from 'node:assert/strict';
import {
  PLAN_PANE_WEB_PREFERENCES,
  planSurfaceCsp,
  wrapPlanSurfaceDocument,
  buildPlanSurfaceDataUrl,
  clampPaneBoundsToContent,
} from './plan-render-pane';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

test('web preferences pin every hardening field, JS disabled', () => {
  const p = PLAN_PANE_WEB_PREFERENCES;
  assert.equal(p.javascript, false, 'javascript execution disabled');
  assert.equal(p.sandbox, true);
  assert.equal(p.contextIsolation, true);
  assert.equal(p.nodeIntegration, false);
  assert.equal(p.nodeIntegrationInSubFrames, false);
  assert.equal(p.webSecurity, true, 'never inherit the shell webSecurity:false');
  assert.equal(p.allowRunningInsecureContent, false);
  assert.equal(p.webviewTag, false);
  assert.equal(p.preload, undefined, 'no dashboard preload on the surface pane');
});

test('CSP denies by default and defines no script-src', () => {
  const csp = planSurfaceCsp();
  assert.ok(csp.includes("default-src 'none'"), 'default-src none');
  assert.ok(!/script-src/.test(csp), 'no script-src → scripts fall back to none');
  assert.ok(csp.includes("base-uri 'none'"), 'base locked');
  assert.ok(csp.includes("frame-ancestors 'none'"), 'no framing');
  assert.ok(csp.includes("form-action 'none'"), 'no form submission');
});

test('document wrapper carries the CSP meta and the body', () => {
  const doc = wrapPlanSurfaceDocument('<p data-anchor="sec_a1">hi</p>');
  assert.ok(doc.startsWith('<!doctype html>'), 'valid document');
  assert.ok(doc.includes('http-equiv="Content-Security-Policy"'), 'CSP meta present');
  assert.ok(doc.includes(planSurfaceCsp()), 'CSP value matches policy');
  assert.ok(doc.includes('sec_a1'), 'body content inlined');
});

test('data URL sanitizes source then encodes a self-contained document', () => {
  const { html, dataUrl } = buildPlanSurfaceDataUrl('<p onclick="x()">hi<script>evil()</script></p>');
  assert.ok(!html.toLowerCase().includes('<script'), 'script stripped before wrapping');
  assert.ok(!html.toLowerCase().includes('onclick'), 'inline handler stripped');
  assert.ok(dataUrl.startsWith('data:text/html;charset=utf-8,'), 'data URL scheme');
  assert.ok(!decodeURIComponent(dataUrl).toLowerCase().includes('evil()'), 'no script body survives encoding');
});

test('empty / nullish source is safe', () => {
  assert.doesNotThrow(() => buildPlanSurfaceDataUrl(''));
  assert.doesNotThrow(() => buildPlanSurfaceDataUrl(undefined as unknown as string));
});

test('document is scrollable: pins html/body height and lets the body overflow', () => {
  const doc = wrapPlanSurfaceDocument('<p>hi</p>');
  assert.ok(doc.includes('<style>'), 'inline style block present');
  assert.ok(/html\s*,\s*body\s*\{[^}]*height:\s*100%/.test(doc), 'scroll container pinned to viewport height');
  assert.ok(/body\s*\{[^}]*overflow-y:\s*auto/.test(doc), 'body scrolls vertically');
  assert.ok(/overflow-x:\s*hidden/.test(doc), 'no stray horizontal scroll');
});

test('document uses a centered readable layout (WP4)', () => {
  const doc = wrapPlanSurfaceDocument('<p>hi</p>');
  // Centered, capped reading column with generous side padding.
  assert.ok(/body>\*\{[^}]*max-width:\s*760px/.test(doc), 'readable column capped');
  assert.ok(/margin-left:\s*auto/.test(doc), 'column centered');
  // Seed-section spacing keys off the provenance anchor.
  assert.ok(/section\[data-anchor\]/.test(doc), 'section[data-anchor] spacing rule present');
  // Baseline typography without breaking scrollability (asserted above).
  assert.ok(/font:\s*14px/.test(doc), 'baseline body font set');
});

test('document CSS is theme-aware: explicit solid background in both themes, never transparent', () => {
  const doc = wrapPlanSurfaceDocument('<p>hi</p>');
  // Base (light/"paper") body carries an EXPLICIT solid background — the old
  // `background:transparent` composited pale text over the light shell (washed out).
  assert.ok(/body\s*\{[^}]*background:\s*#fbfaf7/.test(doc), 'light body solid background set');
  assert.ok(!/background:\s*transparent/.test(doc), 'no transparent background anywhere');
  assert.ok(/body\s*\{[^}]*color:\s*#211f1c/.test(doc), 'light body has readable ink text');
  // Dark override tracks the app theme via prefers-color-scheme (nativeTheme drives it).
  assert.ok(/@media\s*\(prefers-color-scheme:\s*dark\)/.test(doc), 'dark media query present');
  assert.ok(/@media[^}]*body\s*\{[^}]*background:\s*#1e1e1e/.test(doc), 'dark body solid background set');
  assert.ok(/@media[^}]*body\s*\{[^}]*color:\s*#cccccc/.test(doc), 'dark body has readable light text');
  // Headings, hints, and code/table chrome are colored in both palettes (no
  // pale-on-pale). Light heading ink + light muted hint; dark overrides both.
  assert.ok(/h1\s*,\s*h2\s*\{[^}]*color:\s*#000000/.test(doc), 'light headings inked');
  assert.ok(/\.zone-hint\s*\{[^}]*color:\s*#8e887a/.test(doc), 'light hint uses muted ink, not the darker dark-theme grey');
  // Dark heading rule (only #ffffff heading color lives in the dark block).
  assert.ok(/h1\s*,\s*h2\s*\{\s*color:\s*#ffffff/.test(doc), 'dark headings brightened');
});

test('clampPaneBoundsToContent keeps an off-bottom pane inside the visible content', () => {
  // Host rect starts at y=100 and is 2000px tall in an 800-tall window: the pane
  // would paint 1300px below the screen. Clamp the height to what remains.
  const clamped = clampPaneBoundsToContent(
    { x: 0, y: 100, width: 1200, height: 2000 },
    { width: 1000, height: 800 },
  );
  assert.equal(clamped.y, 100);
  assert.equal(clamped.height, 700, 'height clamped to content bottom (800-100)');
  assert.equal(clamped.width, 1000, 'width clamped to content right');
});

test('clampPaneBoundsToContent floors negatives and never goes below zero', () => {
  const clamped = clampPaneBoundsToContent(
    { x: -20, y: -40, width: 500, height: 500 },
    { width: 300, height: 300 },
  );
  assert.equal(clamped.x, 0);
  assert.equal(clamped.y, 0);
  assert.equal(clamped.width, 300);
  assert.equal(clamped.height, 300);
  // A rect fully below the content collapses to zero height rather than negative.
  const offscreen = clampPaneBoundsToContent(
    { x: 0, y: 900, width: 100, height: 100 },
    { width: 800, height: 800 },
  );
  assert.equal(offscreen.height, 0);
});

// ── Runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

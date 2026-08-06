// WP-I startup wiring gate: the legacy mutate service stays unwired, folder
// settlement invokes the single-flight drain, and boot awaits drain+retirement.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');

assert.match(source, /providePromotionService\(null\)/,
  'legacy proposal:promote service must remain unavailable');
assert.doesNotMatch(source, /providePromotionService\(promotionService\)/,
  'startup must not re-enable the request-minting saga');
assert.match(source, /onPlanFolderSettled:\s*async[\s\S]*legacyPromotionDrain\.drainAndRetire\(\)/,
  'structured-folder settlement must run the legacy drain');
assert.match(source, /const legacyBootReport = await legacyPromotionDrain\.drainAndRetire\(\)/,
  'boot must await the drain before observing retirement');
assert.doesNotMatch(source, /void\s+legacyPromotionDrain\.drainAndRetire\(\)/,
  'the catastrophic fire-and-forget drain shape is forbidden');

console.log('  ok  legacy promotion startup is submit-only, settlement-wired, and awaited');
console.log('\n1 passed, 0 failed');

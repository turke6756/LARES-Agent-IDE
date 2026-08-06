// Compatibility import path for compiled test registries and downstream local
// tooling. The legacy saga reconciler was retired by WP-I; all behavior lives in
// the authority-safe drain.
export * from './legacy-promotion-drain';

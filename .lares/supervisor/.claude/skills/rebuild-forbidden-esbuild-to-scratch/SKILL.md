---
name: rebuild-forbidden-esbuild-to-scratch
description: >-
  The task requires running compiled-output tests but constraints forbid builds because the dev app is running from dist/ (or holds native bindings).
---
Don't run the project build and don't skip the tests. Bundle the test entry standalone with an in-repo transpiler (esbuild src/x.test.ts --bundle --platform=node --external:electron --outfile=<scratchpad>/x.test.cjs) and run it with node from the scratchpad — the app's dist/ is never touched. Pair it with tsc -p <tsconfig> --noEmit for type safety, since the bundler doesn't typecheck.

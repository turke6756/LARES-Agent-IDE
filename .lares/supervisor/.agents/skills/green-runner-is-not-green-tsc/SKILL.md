---
name: green-runner-is-not-green-tsc
description: >-
  You add a source file and its tests, the suite passes, and you're about to commit on that evidence alone.
---
Run the project's typechecker too, filtered to your own files (tsc --noEmit, then grep your paths). A test runner and a build tool routinely carry path aliases, JSX settings, and paths mappings the typechecker's config does NOT, so an import that resolves perfectly at test time can be a hard type error in the real build. The failure is invisible in the runner's output and surfaces as someone else's broken build later. Two toolchains, two configs, two greens — get both before committing.

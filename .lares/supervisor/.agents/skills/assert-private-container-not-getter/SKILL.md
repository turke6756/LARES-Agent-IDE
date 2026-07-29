---
name: assert-private-container-not-getter
description: >-
  A spec asks you to prove a rejected operation left NO state behind, and the class exposes a convenient getFooState(id) accessor.
---
Check whether that accessor lazily CREATES the entry (a get-or-insert getState). If it does, calling it in the test manufactures the very state you were about to prove absent, and the assertion passes no matter what the code does. Assert the private container directly ((obj as unknown as { m: Map<string, unknown> }).m.has(id) === false) BEFORE any accessor call, then use the public getter only for value assertions. Same shape as any observer-with-side-effects: read the raw store first.

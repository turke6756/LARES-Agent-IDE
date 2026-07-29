---
name: inject-fake-for-subprocess-oracle
description: >-
  You're testing a decision that in one branch shells out to a live oracle (a git rev-parse to tell a branch from a filename, a stat to tell a dir from a file, a DNS/HTTP probe), and you have a plain table row exercising that branch against the real subprocess.
---
Route the oracle through an injectable seam and write the ambiguous-branch tests with a FAKE that resolves/rejects deterministically — plus a spy test asserting the unconditional branches never call the oracle at all. A table row backed by the real subprocess can pass even when the guard's own logic is mutated away, because the subprocess independently produces the same verdict. Mutation-test it: negate the guard's special-case and confirm the INJECTED test — not the real-subprocess row — is the one that fails.

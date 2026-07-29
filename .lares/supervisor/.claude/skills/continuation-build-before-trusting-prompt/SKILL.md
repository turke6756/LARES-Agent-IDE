---
name: continuation-build-before-trusting-prompt
description: >-
  Inheriting a "previous worker ran out of context mid-edit; expect a non-compiling / half-applied file — finish it" handoff.
---
Reconcile from disk and run the actual build/compile before assuming breakage. The handoff's account of where the prior worker stopped is a hint, not fact — they may have left the slice coherent (or broken somewhere else). A green build tells you the real remaining surface is behavior/tests, not getting it to compile, and stops you from "rewriting" work already done. Still read each named file fully for latent logic bugs the compiler can't catch (e.g. resolving a rule from the wrong URL) — but let the toolchain, not the prose, define "is it broken."

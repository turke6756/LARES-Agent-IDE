---
name: single-call-site-is-a-sample
description: >-
  Your task says "fix the packaged path at <file>:<line>" (or any single-site resolution/env/config fix) and gives you exact code to paste there.
---
Apply it, then grep the whole tree for the THING being resolved before declaring done — a second consumer resolving the same asset by its own relative walk is the normal case, not the exception, and it fails identically. Then run the real built artifact and read its startup log: an end-to-end smoke that exercises the shipped layout finds sites a source read and a green compile both miss. Prefer collapsing the duplicated resolution into one shared helper so the next such fix has exactly one site. Report the extra site as a spec-vs-reality mismatch rather than silently widening scope.

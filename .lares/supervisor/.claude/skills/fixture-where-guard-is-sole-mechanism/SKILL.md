---
name: fixture-where-guard-is-sole-mechanism
description: >-
  You're testing a rule that overrides or supplements another rule (a tie-breaker, disagreement override, fallback), and your fixture happens to satisfy the base rule too.
---
Before mutating, ask: "if I deleted the guard, would another code path still produce this expected value on this fixture?" If yes, redesign the fixture so the guard ALONE determines the outcome — otherwise the test stays green under the mutation and proves nothing about the guard. State in a comment WHY the fixture was chosen ("base rule says X; only the override yields Y").

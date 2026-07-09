# Vision

> Lares — an agent-native workspace for orchestrating AI agents across
> terminals, files, browsers, documents, and notebooks.

## Why "Lares"

The *Lares* were the Roman household guardian deities — the spirits that watched
over the home and everyone working within it. The name is a deliberate fit for
this project's core thesis: **AI agents should never be a black box.** Lares
watches over your workspace, keeping every agent visible, addressable, and
interruptible while it works.

The project was formerly named **AgentDashboard**. Lares is the same product,
renamed for its public launch.

## The problem

Most tooling for AI agents pushes in one of two directions. Either you get a
single assistant bolted into an editor — powerful, but narrow, and framed as a
coding tool. Or you get *headless* orchestration: fleets of agents running
somewhere you can't see, optimized for throughput, with no surface a human can
watch or reach into. Headless orchestration buys you scale and gives up
visibility; a single in-editor assistant buys you visibility and gives up scale
and breadth.

Lares refuses that trade. The wager is that as agents take on more real work, the
scarce resource is not raw throughput — it's **trust**, and trust comes from
being able to *see* what agents are doing and *reach in* when they go wrong.

## The thesis: visibility first

Lares is built on one non-negotiable idea: **every agent runs in a live,
attended session a human can watch and take over.** Agents are launched into real
terminals, not fired off as one-shot background jobs. You see each agent's
status and context usage on a live rail, attach to any agent's chat to read its
reasoning and tool calls, and inspect exactly which files it read versus wrote.
When an agent drifts, intervention is *takeover, not restart* — you grab the same
terminal, browser tab, or notebook cell it was driving and correct course.

This is why Lares calls itself an **agent-native workspace** rather than an AI
IDE or a "Claude Code wrapper." Code is one artifact among many. The workspace is
built so that humans and agents act on the **same** files, documents, notebooks,
and browser sessions, through paired affordances: for everything a human can do
to an artifact, an agent has a tool that does the same thing to the same
artifact, and vice versa. Transparency isn't a feature painted onto the agent —
it lives in the shared artifact.

## What Lares is built on

Three ideas carry the design:

- **The primitive is an agent session, not an LLM call.** The unit Lares manages
  is one live, interactive instance of an agentic CLI — a model running inside a
  harness (its tool loop and terminal client). Because every provider now ships
  this same shape, "agent session" is provider-neutral by construction: Lares can
  run and coordinate a mix of harnesses side by side. Claude Code is the
  reference harness Lares is developed and tested against today; see
  [Setup](./setup.md) for what a working install requires.

- **Orchestration is policy over mechanism.** Coordination composes two control
  planes. *Mechanism* (scripts, the message bus, the group-deliberation protocol)
  is deterministic and auditable — it guarantees the *shape* of collaboration.
  *Policy* (an agent's judgment about when to convene a deliberation, whom to
  include, how to frame the question) supplies the *intent*. Good orchestration is
  continuously deciding which plane each concern belongs on.

- **Agents are organized like an org chart.** Personas — supervisor, worker,
  researcher — are nodes in a topology, each pairing a tool grant (the mechanism
  it may fire) with a behavioral spec (the policy it is primed for). A supervisor
  carries the orchestration tools and delegates waves of work to workers and
  researchers; the human supervises the supervisor.

## Where it is today

Lares is an early, honest alpha. It runs from source on Windows with WSL, is
developed and tested against Claude Code as the reference harness, and wires in a
second provider for cross-provider "groupthink" deliberation. Security boundaries
are experimental and incomplete — read [SECURITY.md](../SECURITY.md) before you
run it.

## Read next

- [Architecture](./architecture.md) — how the pieces fit together in the code.
- [Setup](./setup.md) — install and run from a fresh clone.
- [Workflows](./workflows.md) — the multi-agent patterns Lares is built for.
- [Security](./security.md) — the full threat model.

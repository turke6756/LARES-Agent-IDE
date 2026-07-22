# Vision

> Lares — an agent-native workspace for orchestrating AI agents across
> terminals, files, browsers, documents, and notebooks. **A harness for agent
> harnesses.**

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

Underneath both failures sits a hard constraint: **every agent has a finite
context window.** One agent cannot hold a large project in its head, so real
work at scale means many agents — and the moment you have more than one, you
need a system that organizes them, lets them talk to each other, and arranges
them into a hierarchy of roles that divides work into pieces each agent's
context can actually carry.

Lares refuses the visibility-versus-scale trade. The wager is that as agents
take on more real work, two resources become scarce at once: **trust** on the
human side — which comes from being able to *see* what agents are doing and
*reach in* when they go wrong — and **context** on the agent side, which must be
budgeted, monitored, and divided like the finite resource it is. Lares is built
to economize both.

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

Five ideas carry the design:

- **The primitive is an agent, not an LLM call.** An agent is a model running
  inside a lab-built harness — Claude Code, Codex — whose job is to let the
  model work through a terminal or client interface. Model + harness together
  is the unit. Lares never reaches under that harness to the provider API; it
  manages one live, interactive instance of the whole thing. Because more than
  one provider now ships this terminal-agent shape, "agent" is provider-neutral
  by construction: Lares can coordinate compatible harnesses side by side
  without integrating raw model APIs. Claude Code is the reference harness
  Lares is developed and tested against today; see [Setup](./setup.md) for what
  a working install requires.

- **Lares is a harness for those harnesses.** A provider's harness gives its
  model tools to act on a workspace; Lares gives whole agents tools to act on
  *each other*. Through the dashboard's MCP server, authorized agents — above
  all the supervisor — can launch other agents, message them, read their chats
  and files-touched, and coordinate them up a hierarchy — capabilities no
  single provider harness supplies. And the outer harness has a personality:
  the supervisor's system prompt and the app's role scaffolds encode *how* to
  use those tools — when to convene a deliberation, where to write plans, how
  to conserve context — so good multi-agent practice emerges from using the app
  rather than from a checklist.

- **Context is the scarce resource, and hierarchy is how you spend it.** Every
  agent has a finite context window, so the org chart is not decoration — it is
  a divide-and-conquer strategy over context. Personas — supervisor, worker,
  researcher — are nodes in a topology, each pairing a tool grant (the
  mechanism it may fire) with a behavioral spec (the policy it is primed for).
  A supervisor holds the high-level goals and dispatches waves of work sized to
  fit a worker's window; workers report back with results *and* their remaining
  context, and the supervisor decides whether to keep them working or spawn
  fresh; the supervisor itself hands off to a successor session before its own
  window fills. The human supervises the supervisor.

- **Orchestration is policy over mechanism.** Coordination composes two control
  planes. *Mechanism* (orchestration scripts, the message bus, the
  group-deliberation protocol) is deterministic and auditable — it guarantees
  the *shape* of collaboration, the same way every time. *Policy* (an agent's
  judgment about when to convene a deliberation, whom to include, how to frame
  the question) supplies the *intent*. Good orchestration is continuously
  deciding which plane each concern belongs on.

- **Cross-provider deliberation is a primitive, not a trick.** Models from
  different labs have different strengths and blind spots, and they are
  remarkably good at catching each other's mistakes — in adversarial review or
  plain collaboration. Lares makes that a scripted, repeatable interaction: a
  **groupthink** run launches two full agents from different providers, relays
  messages between them, counts turns, and gates completion on a final
  artifact — in *parallel* mode (independent solutions, preserving genuine
  independent judgment, then reconciliation) or *serial* mode (proposal, then
  pushback). Convening one is a supervisor tool call, not a copy-paste ritual.

## Where this came from

I built Lares as a master's student at the University of San Francisco, for
myself, around the way I actually like to work. It started from a plain
observation: once agents write most of the code, an IDE stops being an IDE —
what's left is a file editor with a model attached. So rather than a coding tool
that grudgingly tolerates everything else, I built a workspace that treats
*every* artifact as first-class, and puts as much care into the Markdown editing
and review experience as into the terminals. I don't just vibe-code in Lares; I
draft emails here, write cover letters, and stand up my job-hunt workflows. Code
is one tool on the bench, not the bench itself.

Lares shares a starting idea with [cmux](https://github.com/manaflow-ai/cmux):
use the harness's own lifecycle hooks to give each agent a live status —
*working*, *idle*, *needs input* — so a terminal session becomes something you
watch rather than something you babysit. Any terminal multiplexer can pop open
a grid of agents; the difference is whether those terminals open into a
*system* — one that knows who's who, gives agents a channel to each other, and
coordinates them into primitive interactions like a groupthink. Where Lares
diverges is everything it
builds on top of that: a graphical, agent-to-agent workspace where agents are
organized into a hierarchy with real ownership, where a supervisor is your point
person for a whole wave of workers and is notified as each one's status changes,
and where the app's own behavior quietly encodes good agentic practice — so that
best practices emerge from *using* it rather than from a checklist you have to
remember.

## Where it is today

Lares is an early, honest alpha. It runs from source on Windows with WSL, is
developed and tested against Claude Code as the reference harness, and wires in a
second provider for cross-provider "groupthink" deliberation. The architecture
is provider-neutral, but support for arbitrary harnesses is still a direction,
not a current guarantee. Security boundaries
are experimental and incomplete — read [SECURITY.md](../SECURITY.md) before you
run it.

## Where it's going

I think the IDE is heading somewhere stripped down and agent-forward, and that's
the direction I want to take Lares. The horizons I care about most: scheduled,
cron-driven agent runs so work happens on a timer without you at the desk; a
companion mobile app; and — in the spirit of giving your workspace its own
presence — its own phone number and email address, so you can message your IDE
and hand it work from anywhere. The [README](../README.md#roadmap) tracks the
concrete near-term roadmap; this is the longer arc it's pointed at.

## Read next

- [Architecture](./architecture.md) — how the pieces fit together in the code.
- [Setup](./setup.md) — install and run from a fresh clone.
- [Workflows](./workflows.md) — the multi-agent patterns Lares is built for.
- [Security](./security.md) — the full threat model.

# Lares Recording — Voice Memo Transcript

- **Source:** Gmail, "Lares recording" (self-sent, Mon Jul 20 2026, 22:14)
- **Attachment:** `Cesar Chavez St.m4a` (7 min 20 s)
- **Transcribed:** Whisper `large-v3-turbo`, 2026-07-21
- **Note:** Whisper mishears some product names — "LARUS" → *Lares*, "quad code" → *Claude Code*, "codecs" → *Codex*. Text below is verbatim from the model.

---

So for LARUS, the agent IDE, I need to refocus the main narrative a little bit, I think. I really want to hit on how it's a harness for a harness.

So an agent is a large language model inside a harness called quad code. That's what it's called when you put those two together. And the quad code harness is just what allows it to interact with the commands through a terminal or client interface, right?

Now, the application is like a terminal multiplexer, kind of like CMUX. So you're going to be able to pop up a lot of terminals. Each terminal is going to have an agent in it. The agent is going to be in the provider harness, and you can have codecs and quad code. And the thing is, is through an MCP server, they can talk to each other. So they actually have MCP tools provided to them by the app. So the app is kind of like a harness for the agent harnesses. So it provides more tools for them to talk to each other, more tools for them to spawn each other.

And importantly, you know, it's orchestrated by a supervisor agent. So there's a native hierarchy. And the supervisor has the MCP tools that it needs to spawn agents and have them communicate with each other.

But the real trick, one of the most powerful things about this app is that you really do want and need models in their lab-built harnesses, so quad code and codecs, different models working together because each model has its pros and cons, its strengths and weaknesses. And when you put them together in an adversarial type of review or just in a collaborative sense, they're really good at catching each other's mistakes, seeing what each other did not see.

And the way that you choose to orchestrate the interaction is not random, it's scripted. And the scripting that is done is what is the harness for the agent harness, if you will. So part of the app's job is to be a harness for the harnesses. And what that is is like, yes, it's the supervisor calling a tool, but that tool is a scripted tool. So it's going to happen the same way every time.

And what it does is it's a script called Groupthink that uses the app's own MCP tools, just like the supervisor would use, to do what, to spawn agents and to have two agents of a different provider, codecs or Anthropic and OpenAI, discuss with each other. So the script does the forwarding of the messages between the two agents. And it counts the number of turns, and it makes sure that it copies and pastes the messages back and forth, and it sets the stage. Well, the supervisor does the stage setting. But the script will make sure that they've gone back and forth, and that a final asset has been created. A final... Right.

So anyways, the application is the harness for the harness. It's the terminal multiplexer. It's more than a terminal multiplexer, in more than one sense. Any agent in a terminal multiplexer would be able to, I would assume, spawn other agents and have them communicate with each other. But I'm not sure if that's true. I don't know if CMUX does that, but I'm positive people are figuring out how to do this. Um, so the app does this. And, well, it does it quite well. And it does it in two different formats, parallel, serial.

And, right, so it's more than just CMUX because it's also just has all the niceties of viewing files and making comments and doing edits. So it's a complete, it's a complete system. And it has a dedicated behavior. Like, if you just open CMUX, you could create all these terminals and do all these things. But the app has a certain level of behavioral characteristics that the prompts of the supervisor's system prompt, its cloud.md file enables. So the app has a personality.

Now, personality is how to use the tools to perform group things, when to perform them, where to write down the plans, um, how to save context. So it's a harness for the harness. It does all the niceties that you want when you work with multiple agents.

So I think that's the key concept is that if you're going to pop open a lot of agents in a bunch of terminals, you don't want it to just be a scattered mess of terminals. You want those terminals to pop open in a system that organizes them, in a system that keeps track of who's who, in a system that coordinates them for you into certain, what we'll say, primitive interactions, which a group think would be a primitive interaction.

So it's a harness for agent harnesses. So... but, that's the reality.

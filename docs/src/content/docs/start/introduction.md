---
title: Introduction
description: Why dynmcp exists and what problem it solves.
---

You wire up Chrome DevTools, a filesystem server, and a couple of cloud SDKs. Your agent now sees a few hundred tool schemas, every turn, whether it needs them or not. That's the problem `dynmcp` is built to solve.

## The problem

One large MCP can expose dozens of tools. Two or three of them at once and the combined catalog gets injected into your agent's context window on every request. Most of that catalog is irrelevant to whatever the agent is doing right now.

The agent pays for it twice. Once in tokens, every turn, because the schemas are sitting in context. Once in decision quality, because the more tools an agent stares at, the worse it gets at picking the right one (and the more likely it is to hallucinate one that doesn't exist).

For any given task, only a small slice of the catalog is actually relevant. The rest is noise.

## The fix

`dynmcp` puts a thin proxy in front of your MCPs and swaps the catalog for two small tools:

- **`discover_tool`** — the agent reads its description to see what tools exist. Up front, it only gets names and one-line summaries. When it wants the full schema for a specific tool, it calls `discover_tool` with that tool's name.
- **`use_tool`** — once the agent has the schema, it calls `use_tool` to run the tool. The proxy forwards the call to the right upstream and hands the result back.

So the agent's flow goes: read the catalog, pull the schemas for the one or two tools it actually needs, call them. Schemas for everything the agent never reaches for never enter context. That's the whole trick.

[Dynamic Discovery](/guides/dynamic-discovery/) takes the same idea one level up. Mark a whole MCP server as "load on demand" and the proxy won't even open a connection to it until the agent asks.

## Nothing else changes

The tool catalog is the only thing `dynmcp` reshapes. Resources, prompts, completion, logging, notifications, cancellation, progress, and server-initiated requests (sampling, elicitation, roots) all pass through unchanged. From your host's perspective, talking to `dynmcp` is the same as talking to each upstream directly, minus the schema flood.

## Local only

`dynmcp` runs on your machine. It talks to your agent host (IDE, agent runner, whatever you use) over stdio, and connects to upstreams over whichever transport you've configured: spawned stdio child processes, HTTP, or SSE. There is no remote `dynmcp` service to deploy.

## Where to next

- [Install dynmcp](/start/installation/) — takes under a minute.
- [Quick start](/start/quick-start/) — wrap one MCP and see it work.
- [Config file](/guides/config-file/) — proxy several at once.

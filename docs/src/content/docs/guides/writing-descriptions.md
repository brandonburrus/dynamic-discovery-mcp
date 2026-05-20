---
title: Writing Good Descriptions
description: How to write lazy MCP descriptions that an agent can actually act on.
---

The `description` field on a lazy MCP is what an agent reads, on every `discover_tool` call, to decide whether to load that server. A vague description means the agent loads the wrong MCP, loads nothing, or burns tokens guessing. A specific one gets it right on the first try.

Think of it as briefing a teammate who's never seen the MCP. A few sentences, no fluff.

## What to put in

Lead with the verbs. What can the agent actually *do* once this MCP is loaded? "Navigate pages, take screenshots, inspect the DOM" is more useful than "browser automation tooling."

Name the domain. The system, surface, or data the MCP operates on. "Chrome browser," "AWS documentation," "Jira issues" — give the agent something to anchor on.

End with a "use when" clause. A short hint about the kinds of tasks the MCP is appropriate for. This is what helps the agent pick correctly when several lazy MCPs sound plausible.

Keep it tight. Every word here costs tokens on every discovery call.

## Examples

```json
{
  "chrome-devtools": {
    "description": "Chrome browser automation and DevTools control. Navigate pages, take screenshots, inspect the DOM, run JavaScript, record performance traces, analyze network requests, read console messages. Use for any task that needs to interact with or debug a live web page.",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "chrome-devtools-mcp@latest"]
  }
}
```

```json
{
  "aws-knowledge": {
    "description": "AWS documentation, code samples, and best-practice guidance. Search and read AWS docs, API references, blog posts, CDK/CloudFormation templates, and regional availability info. Use when the task involves AWS services or infrastructure-as-code.",
    "transport": "streamable-http",
    "url": "https://knowledge-mcp.global.api.aws"
  }
}
```

```json
{
  "jira": {
    "description": "Read and write Jira issues, comments, transitions, and sprint state. Use when the task involves tracking work or referencing tickets.",
    "transport": "streamable-http",
    "url": "https://example.com/jira/mcp"
  }
}
```

## What to skip

Marketing copy. "The most powerful browser automation experience" tells the agent nothing about whether to load it.

Per-tool listings. Don't enumerate individual tool names — that's what `discover_tool` is for. Stay at the level of verbs and domain.

One-word descriptions. "Browser." is a category, not an instruction. The agent has no way to know whether this is a headless test runner, a screenshot service, or something else.

Lead-ins like "An MCP that…". Pure overhead. Open with what the MCP does.

A description with no "use when" clause. Without it, an agent staring at several lazy MCPs has to guess from verbs alone.

## Validation

If you include a `description`, it has to be a non-empty string after [environment-variable interpolation](/guides/environment-variables/). An empty or whitespace-only description causes a startup error. `dynmcp` won't let you ship a placeholder.

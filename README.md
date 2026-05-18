# dynamic-mcp

A proxy MCP that exposes meta-tools so agents can discover and call upstream MCP tools on demand, without loading every tool schema into the context window.

## The Problem

Large MCPs routinely expose tens to hundreds of tools. When several are active at once, every tool schema is injected into the context window on every request regardless of relevance — degrading decision quality and consuming tokens unnecessarily. For any given task, only a small subset of tools is actually relevant.

## How It Works

`dynamic-mcp` sits in front of an upstream MCP and exposes exactly two tools:

- **`discover_tool`** — its description contains a compact catalog of every upstream tool (name and one-line summary). Call it with a tool name to get that tool's full schema: description, parameters, types, and required fields.
- **`use_tool`** — executes a tool by name, proxying the call to the upstream MCP and returning its output unchanged.

The agent workflow: scan the catalog in `discover_tool`'s description to find relevant tools, call `discover_tool` to load the full schema of the one it needs, then call `use_tool` to execute it. Full schemas of tools the agent never needs never enter the context window.

`dynamic-mcp` runs locally, communicating with both the agent host and the upstream MCP over stdio.

## Usage

Requires Node.js >= 20.

Prefix any MCP invocation with `dynamic-mcp --`:

```bash
# Before
npx -y chrome-devtools-mcp@latest

# With dynamic-mcp
npx dynamic-mcp@latest -- npx -y chrome-devtools-mcp@latest
```

Everything after `--` is the command used to launch the upstream MCP.


---
title: Config File Mode
description: Proxy multiple upstream MCPs through a single dynmcp instance using a config file.
---

To proxy more than one MCP from a single `dynmcp` instance, list them in a config file. JSON and YAML both work.

```bash
# Auto-discover mcp.json or .mcp.json in cwd
npx dynmcp@latest

# Or specify explicitly
npx dynmcp@latest --config ./my-config.json
```

## File discovery

Without a `--` command, `dynmcp` looks for a config file in this order:

1. The path you passed to `-c` / `--config`.
2. `mcp.json` in the current working directory.
3. `.mcp.json` in the current working directory.

If none of those exist and there's no `--` command either, `dynmcp` exits with a clear error.

## Supported formats

The file extension picks the parser:

| Extension | Parser |
|---|---|
| `.json` | JSON |
| `.yml`, `.yaml` | YAML |

## Minimal example

```json
{
  "$schema": "https://dynamicmcp.tools/config.json",
  "mcp": {
    "chrome-devtools": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

The `$schema` line is optional but worth including. Editors like VS Code will pick it up and give you autocomplete and validation against the [published JSON Schema](https://dynamicmcp.tools/config.json).

## Namespaced tool names

In config file mode, every tool name gets prefixed with its MCP's key from the config, joined by `/`:

- `browser_navigate` from `chrome-devtools` becomes `chrome-devtools/browser_navigate`.
- `read_file` from `filesystem` becomes `filesystem/read_file`.

This is required, not optional. Two MCPs might define a tool with the same name, and the prefix is what tells them apart. Resource URIs and prompt names are forwarded as-is, no prefix.

## Naming rules

MCP keys must match `/^[a-z0-9][a-z0-9-]*$/`: lowercase ASCII letters, digits, and hyphens, starting with a letter or digit.

## Transports

`dynmcp` supports three. The [Transports reference](/reference/transports/) has the full field list.

| Transport | Use it for |
|---|---|
| `stdio` | Local MCPs launched as child processes. |
| `streamable-http` | Remote MCPs over HTTP. |
| `sse` | Remote MCPs over Server-Sent Events. |

A multi-transport config:

```json
{
  "$schema": "https://dynamicmcp.tools/config.json",
  "mcp": {
    "chrome-devtools": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "aws-knowledge": {
      "transport": "streamable-http",
      "url": "https://knowledge-mcp.global.api.aws"
    },
    "remote-sse": {
      "transport": "sse",
      "url": "https://example.com/sse",
      "headers": {
        "Authorization": "Bearer my-token"
      }
    }
  }
}
```

## YAML equivalent

```yaml
mcp:
  chrome-devtools:
    transport: stdio
    command: npx
    args: ["-y", "chrome-devtools-mcp@latest"]

  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]

  aws-knowledge:
    transport: streamable-http
    url: https://knowledge-mcp.global.api.aws
```

## Next steps

- [Dynamic Discovery](/guides/dynamic-discovery/) — defer expensive MCPs until they're needed.
- [Environment Variables](/guides/environment-variables/) — keep secrets out of the config file.
- [Config Schema](/reference/config-schema/) — full field-by-field reference.

---
title: Installation
description: Requirements and install options for dynmcp.
---

`dynmcp` ships on npm as [`dynmcp`](https://www.npmjs.com/package/dynmcp) with a CLI binary of the same name.

## Requirements

- **Node.js 20 or higher.** Built as a dual CJS+ESM package and works on every active and current Node LTS line.

## Run it with `npx`

This is what most agent host configs expect, and it doesn't require an install step:

```bash
npx dynmcp@latest [options] [-- <upstream-command> [args...]]
```

`npx` fetches the latest version on demand.

## Global install

```bash
npm install -g dynmcp
```

The `dynmcp` binary lands on your PATH.

## Project-local install

If you keep MCP configuration under version control with the rest of your tooling, install it as a dev dependency:

```bash
npm install --save-dev dynmcp
```

Then invoke via `npx dynmcp` (which resolves the local copy) or wire it into a `package.json` script.

## Verifying

```bash
dynmcp --version
```

## Next

- [Quick Start](/start/quick-start/) — wrap a single upstream MCP in under a minute.

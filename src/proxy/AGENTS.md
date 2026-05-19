# src/proxy/

Implements the full-fidelity MCP proxy that sits between the agent host (over stdio) and one or more upstream MCPs. The proxy applies the discovery pattern only to tools (`discover_tool` / `use_tool`); every other MCP protocol surface — resources, prompts, completion, logging, notifications, cancellation, and server-initiated requests — is passed through transparently per the rules in `SPEC.md` § "Proxy Behavior".

## High-level flow

```
Host  <──── stdio ────>  ProxyServer (SDK Server)
                                │
                                │ delegates via callbacks
                                ▼
                          Orchestrator
                                │
                                │ owns N UpstreamClients
                                ▼
            UpstreamClient (SDK Client) ─── stdio | http | sse ──> Upstream MCP
```

- `ProxyServer` registers all host-facing request and notification handlers and exposes outbound methods (`send*`, `forward*`) the `Orchestrator` calls when forwarding upstream activity.
- `Orchestrator` is the composition root. It owns the public API surface used by `index.ts` but delegates focused responsibilities to internal collaborators:
  - `UpstreamRegistry` owns the lifecycle of every `UpstreamClient` (connect, disconnect, lookup by name, sole-client accessor).
  - `NotificationForwarder` translates upstream-emitted notifications (`tools/list_changed`, `resources/list_changed`, `resources/updated`, `prompts/list_changed`, `notifications/message`) into proxy-emitted notifications, rebuilding catalogs and rewriting the `logger` field along the way.
  - `ResourceRouter` and `PromptRouter` hold per-MCP ownership maps with first-wins collision resolution.
  - `ToolCatalog` builds the `discover_tool` description and tool lookup table.
  - `aggregateCapabilities` (pure function) ORs upstream capabilities into the proxy's outbound capability set.
- `UpstreamClient` wraps the SDK's `Client` for a single upstream MCP: declares client-side capabilities (sampling/elicitation/roots) so upstreams may make server-initiated requests, registers all relevant notification handlers, and exposes typed methods for each request type.

## Module layout

| File | Purpose |
|---|---|
| `index.ts` | Entry points (`startProxy`, `startProxyFromConfig`). Builds an Orchestrator, builds a ProxyServer, wires notification handlers and server-initiated request forwarders between them. Owns signal handlers and shutdown lifecycle. |
| `server.ts` | `ProxyServer` — wraps the SDK `Server`. Registers request handlers (tools, resources, prompts, completion, logging) and exposes `send*` methods for outbound notifications and `forward*` methods for upstream-initiated requests. |
| `orchestrator.ts` | `Orchestrator` — composition root. Holds capability aggregation, catalog/router state, the `toolsByMcp` map, server-initiated request forwarders, and the public API surface used by `index.ts`. Delegates client lifecycle to `UpstreamRegistry` and notification translation to `NotificationForwarder`. |
| `upstream-registry.ts` | `UpstreamRegistry` — narrow lifecycle owner for upstream clients. Provides `connectAll`, `disconnectAll`, `get(name)`, `sole()` (single-MCP shortcut), `entries()`, and `size()`. Connection is all-or-nothing: a failure during `connectAll` tears down already-connected clients before re-throwing. |
| `notification-forwarder.ts` | `NotificationForwarder` — translates upstream notifications into outbound notifications to the host. Owns the `handleX` methods, the `<mcp-name>/` logger-prefixing rule, and catalog rebuilds triggered by `*/list_changed`. Talks to the registry/routers via injected getters so the Orchestrator stays the single owner of the underlying state references. |
| `upstream-client.ts` | `UpstreamClient` — wraps the SDK `Client`. Registers notification handlers and (reverse-direction) request handlers based on callback config. Exposes typed methods for every forward-direction request type. |
| `tool-catalog.ts` | `ToolCatalog` — builds the `<tools>` XML block used in the `discover_tool` description and the lookup table used by `use_tool`. Two factory methods: `fromFlat` (single-MCP mode, bare names) and `fromGrouped` (config-file mode, namespaced names). |
| `resource-router.ts` | `ResourceRouter` — URI → upstream ownership map with first-wins collision resolution. Supports concrete URIs (exact match) and templates (literal prefix match). Concrete matches take precedence over template matches. |
| `prompt-router.ts` | `PromptRouter` — prompt name → upstream ownership map. First-wins collision resolution. Simpler than the resource router (no templates, no prefix matching). |
| `capability-aggregator.ts` | Pure function `aggregateCapabilities(upstreams[])` that ORs upstream capabilities into a single `ServerCapabilities` to advertise to the host. `tools` is always advertised (proxy always exposes the meta-tools); `tools.listChanged` is always `true` (proxy emits it on any upstream's list-changed). |
| `transport-factory.ts` | Builds the appropriate SDK transport (stdio, streamable-http, sse) from a single config entry. |

## Key invariants

- **Tool names are the only thing namespaced.** Resource URIs and prompt names are forwarded verbatim. On collision, the upstream appearing first in config-file order wins.
- **`tools` capability is always advertised**, with `listChanged: true`. The proxy emits `notifications/tools/list_changed` whenever any upstream's tool list changes, so the host re-fetches the regenerated `discover_tool` description.
- **Other capabilities are advertised iff at least one upstream advertises them.** Nested booleans (`resources.subscribe`, `resources.listChanged`, `prompts.listChanged`) are ORed.
- **Single-MCP mode is a 1-entry orchestrator** with `namespaced: false`. There is one code path for both modes; the namespace flag toggles routing behavior.
- **The proxy declares `sampling`, `elicitation`, and `roots` client capabilities to every upstream**, regardless of what the host supports. If an upstream uses a feature the host doesn't support, the host's negative response is forwarded back verbatim.
- **Logger names on `notifications/message` are prefixed with `<mcp-name>/` in config-file mode** (`<mcp-name>` if no logger field was set). In single-MCP mode the field is forwarded verbatim.
- **Cancellation propagates via `AbortSignal` threaded through `ProxyCallOptions`/`UpstreamCallOptions`.** Each `setRequestHandler` extracts `extra.signal` and passes it down the call chain to the SDK Client, which emits `notifications/cancelled` to the upstream when the signal aborts. The SDK manages the actual request-ID translation; the proxy never sees or mints JSON-RPC IDs.
- **Resource and prompt collisions log a warning to stderr at connect time** but do not fail startup. Subsequent collisions detected on `list_changed` are not re-warned (only the most recent `collisions()` snapshot is kept).

## Notification routing

Outbound (host ← upstream):
- `notifications/resources/list_changed` → re-fetch resources for that upstream, rebuild `ResourceRouter`, emit to host.
- `notifications/resources/updated` → forward verbatim.
- `notifications/prompts/list_changed` → re-fetch prompts, rebuild `PromptRouter`, emit to host.
- `notifications/tools/list_changed` → re-fetch tools, rebuild `ToolCatalog`, emit to host (which causes the host to re-read `discover_tool`).
- `notifications/message` (logging) → rewrite `logger` field with `<mcp-name>/` prefix in config-file mode, then forward.

Inbound (host → upstream):
- `notifications/roots/list_changed` → broadcast to every connected upstream that may have requested roots.

## Server-initiated requests (upstream → host)

The `UpstreamClient` registers request handlers on its SDK `Client` for `sampling/createMessage`, `elicitation/create`, and `roots/list`. Each handler invokes a forwarder on the `Orchestrator`, which calls `ProxyServer.forwardX(params, options)`, which in turn calls the matching method on the SDK `Server` (`createMessage`, `elicitInput`, `listRoots`). The upstream's `extra.signal` is threaded through `options.signal` so cancellation by the upstream cancels the host call.

## Deferred work

- **Progress token forward-threading.** The spec requires `progressToken` from `_meta` to flow upstream verbatim and `notifications/progress` from upstreams to be forwarded to the host. `ping` is auto-handled by the SDK. Full progress threading was deferred from the initial implementation — it requires either threading `_meta` through the per-call options chain or having each handler extract `request.params._meta?.progressToken`, install an `onprogress` callback on the SDK Client request, and re-emit notifications to the host with the same token. The skeleton is in place (handlers receive `extra` with `_meta`); only the wiring is missing.

## Things worth knowing if you touch this

- **`buildServer()` vs `start()` on `ProxyServer`**. `start()` is the production entry — it builds the SDK Server and connects it to a `StdioServerTransport`. `buildServer()` returns the SDK Server before connection so tests can pair it with an `InMemoryTransport` for end-to-end protocol exercise without spawning a stdio process.
- **`ProxyServer.catalog` is a function**, not a static reference. This lets the proxy regenerate the `discover_tool` description on the fly after an upstream emits `tools/list_changed`. Tests must pass `() => catalog` rather than the catalog directly.
- **The orchestrator's `toolCatalog` is rebuilt** in `handleToolsListChanged`. Don't cache the reference elsewhere — always go through `orchestrator.catalog` (or the function reference held by `ProxyServer`).
- **The orchestrator's `notificationHandlers` and `serverRequestForwarders` are set after `connect()` returns** but before any upstream traffic can reach them (the only path from upstream to these callbacks is through SDK message dispatch, which happens on later event-loop ticks). If you ever start handling notifications during connect, that ordering will need to change.

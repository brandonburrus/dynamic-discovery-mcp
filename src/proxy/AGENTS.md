# src/proxy/

Implements the full-fidelity MCP proxy that sits between the agent host (over stdio) and one or more upstream MCPs. The proxy applies the discovery pattern only to tools (`discover_tool` / `use_tool` and optionally `load_mcp`); every other MCP protocol surface — resources, prompts, completion, logging, notifications, cancellation, and server-initiated requests — is passed through transparently per the rules in `SPEC.md` § "Proxy Behavior".

When at least one upstream MCP in the config declares a `description` field, **dynamic discovery** is enabled: that MCP becomes lazy (deferred connection) and the proxy exposes the `load_mcp` meta-tool, plus a `<mcp_servers>` block in `discover_tool`'s description. See `SPEC.md` § "Dynamic Discovery" for the lifecycle and capability constraints; the implementation lives mostly in `orchestrator.ts` (`loadMcp` / `runLoadPipeline` / `getListing`) and `lazy-registry.ts`.

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
| `upstream-registry.ts` | `UpstreamRegistry` — narrow lifecycle owner for upstream clients. Provides `connectAll`, `connectOne(name, config)`, `disconnectAll`, `deleteOne(name)`, `get(name)`, `sole()` (single-MCP shortcut), `entries()`, and `size()`. `connectAll` is all-or-nothing; `connectOne` + `deleteOne` are the incremental path used by `loadMcp`. |
| `lazy-registry.ts` | `LazyRegistry` — holds the lazy upstream entries (those declared with a `description` field) until `load_mcp` promotes them to connected. Insertion order is preserved so `<mcp_servers>` renders in config-file order. Used by the orchestrator to build the `discover_tool` description and to resolve `loadMcp(name)` calls. |
| `notification-forwarder.ts` | `NotificationForwarder` — translates upstream notifications into outbound notifications to the host. Owns the `handleX` methods, the `<mcp-name>/` logger-prefixing rule, and triggers catalog rebuilds (via injected `rebuildToolCatalog()` callback) when an upstream emits `tools/list_changed`. Also exposes thin emit-only helpers `notifyToolsListChanged`/`notifyResourcesListChanged`/`notifyPromptsListChanged` used by `loadMcp`, which already has fresh state in hand and just needs to nudge the host. Talks to the registry/routers via injected getters so the Orchestrator stays the single owner of the underlying state references. |
| `upstream-client.ts` | `UpstreamClient` — wraps the SDK `Client`. Registers notification handlers and (reverse-direction) request handlers based on callback config. Exposes typed methods for every forward-direction request type. |
| `tool-catalog.ts` | `ToolCatalog` — builds the `<tools>` XML block used in the `discover_tool` description and the lookup table used by `use_tool`. Two factory methods: `fromFlat` (single-MCP mode, bare names) and `fromGrouped` (config-file mode, namespaced names). |
| `resource-router.ts` | `ResourceRouter` — URI → upstream ownership map with first-wins collision resolution. Supports concrete URIs (exact match) and templates (literal prefix match). Concrete matches take precedence over template matches. |
| `prompt-router.ts` | `PromptRouter` — prompt name → upstream ownership map. First-wins collision resolution. Simpler than the resource router (no templates, no prefix matching). |
| `capability-aggregator.ts` | Pure function `aggregateCapabilities(upstreams[])` that ORs upstream capabilities into a single `ServerCapabilities` to advertise to the host. `tools` is always advertised (proxy always exposes the meta-tools); `tools.listChanged` is always `true` (proxy emits it on any upstream's list-changed). Aggregation runs over **eager** upstreams only — lazy ones contribute nothing at host-initialize time. |
| `transport-factory.ts` | Builds the appropriate SDK transport (stdio, streamable-http, sse) from a single config entry. For HTTP / SSE transports, constructs and wires a `ProxyOAuthProvider` (from `src/auth`) using the configured URL + optional `auth` block; the provider is inert when the upstream doesn't require OAuth and otherwise serves cached tokens / triggers silent refresh / throws `AuthRequiredError`. |
| `lazy-registry.ts` | `LazyRegistry` — tracks lazy-loadable upstream MCPs (those declared in config with a `description` field). Preserves insertion (config-file) order. The orchestrator's `loadMcp` pipeline promotes entries out of here into the connected `UpstreamRegistry`. No "unloaded" state — once an entry is taken, it's gone for the proxy's lifetime. |

## Lazy loading / dynamic discovery

When at least one entry in the config has a `description` field, that MCP becomes a **lazy** upstream: not connected at startup, listed in `discover_tool`'s description under `<mcp_servers>`, and reachable only via the `load_mcp` meta-tool. The proxy as a whole is then in "dynamic discovery enabled" mode; `load_mcp` is registered alongside `discover_tool` and `use_tool`.

Lifecycle states: `lazy → loading → loaded`. Atomic transitions — partial failures roll back to `lazy` (the upstream is disconnected, the lazy entry persists, no host notifications fire). Once `loaded`, an MCP behaves identically to an eager one from then on; there is no `unloaded` state.

Key invariants specific to dynamic discovery:

- **Capability set is fixed at host-initialize.** Lazy MCPs do not contribute to the advertised capabilities. After load, the proxy emits `tools/list_changed` always, and `resources/list_changed` / `prompts/list_changed` only when the loaded MCP advertised that capability AND contributed entries. If no eager MCP advertised the same capability, hosts that strictly gate on the negotiated capability set may ignore the notification. This is the documented trade-off — see SPEC.md § "Dynamic Discovery > Capability Constraint".
- **Routers are constructed with the full priority order** (eager names first, then lazy names, both in config-file order). Lazy slots start empty and populate on load; first-wins collision resolution then falls out naturally without any router rebuild.
- **`Orchestrator.loadMcp` is the single entry point.** It owns idempotency (eager and already-loaded names return current listing with no notifications) and the `inFlightLoads` coalescing map (concurrent same-name calls collapse onto one connection attempt). Unknown names throw a clear error listing the still-lazy alternatives.
- **`NotificationForwarder.notifyXListChanged` are the emit-only helpers** the orchestrator uses on load. They differ from `handleXListChanged` which re-fetch from the upstream — on load we already have the data in hand.
- **`ToolCatalog.fromGroupedWithLazy(groups, lazyDescriptions)`** is the factory the orchestrator uses to build the catalog. `fromGrouped` is a thin wrapper for the no-lazy case (back-compat for tests).
- **`hasDynamicDiscovery` getter on the Orchestrator** is how `index.ts` decides whether to wire the `loadMcp` callback into `ProxyServer`. Single-MCP mode (`--`) never has lazy upstreams — the constructor rejects them.

## Key invariants

- **Tool names are the only thing namespaced.** Resource URIs and prompt names are forwarded verbatim. On collision, the upstream appearing first in config-file order wins.
- **`tools` capability is always advertised**, with `listChanged: true`. The proxy emits `notifications/tools/list_changed` whenever any upstream's tool list changes, or whenever a lazy MCP is promoted to loaded, so the host re-fetches the regenerated `discover_tool` description.
- **Other capabilities are advertised iff at least one EAGER upstream advertises them.** Lazy upstreams are not yet connected at host-`initialize` time and contribute nothing to the negotiated capability set. Nested booleans (`resources.subscribe`, `resources.listChanged`, `prompts.listChanged`) are ORed over eager upstreams. See `SPEC.md` § "Dynamic Discovery > Capability Constraint" for the deliberate trade-off and its implications for host-perceived reachability of lazy MCPs' resources/prompts.
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

Internally-triggered (host ← orchestrator, on successful `load_mcp`):
- `notifications/tools/list_changed` — always emitted; the catalog's `<tools>` and `<mcp_servers>` sections both shift.
- `notifications/resources/list_changed` — only when the loaded MCP advertised `resources` AND contributed at least one resource or template.
- `notifications/prompts/list_changed` — only when the loaded MCP advertised `prompts` AND contributed at least one prompt.

These go through `NotificationForwarder.notifyX...ListChanged()` (emit-only) rather than `handleX...ListChanged()` (which would refetch — wasteful since `loadMcp` already has fresh data).

Inbound (host → upstream):
- `notifications/roots/list_changed` → broadcast to every connected upstream that may have requested roots.

Triggered by `loadMcp` success (orchestrator-internal, no upstream notification involved):
- `notifications/tools/list_changed` → always, since the catalog and `<mcp_servers>` block both changed.
- `notifications/resources/list_changed` → only if the loaded MCP advertised the resources capability AND contributed at least one resource or template.
- `notifications/prompts/list_changed` → only if the loaded MCP advertised the prompts capability AND contributed at least one prompt.

These three emissions use the `NotificationForwarder.notifyXListChanged()` helpers — emit-only, no re-fetch — because the orchestrator's `runLoadPipeline` already populated state directly.

## Lazy loading / dynamic discovery

When the orchestrator is constructed with a non-empty `lazyMcps` Map, dynamic discovery is on:

- Lazy entries are registered into `LazyRegistry` during `connect()` but their upstreams are NOT contacted. Only `eagerMcps` are passed to `registry.connectAll`.
- Routers (`ResourceRouter`, `PromptRouter`) are constructed with the full priority list `[...eagerNames, ...lazyNames]` in config-file order. Lazy slots stay empty until their MCP loads. This keeps first-wins collision semantics anchored on config-file order regardless of when each MCP actually contributes data.
- `ToolCatalog` is built via `fromGroupedWithLazy(toolsByMcp, lazyRegistry.descriptions())`. The catalog renders the `<mcp_servers>` block from lazy descriptions and the `<tools>` block from loaded tools. When loaded tools are empty, the `<tools>` block is replaced with a sentence pointing the agent at `load_mcp`.

`Orchestrator.loadMcp(name)` implements:

- **Idempotency** — names already in `UpstreamRegistry` (eager or previously loaded) return the current listing with no notifications.
- **Concurrency coalescing** — `inFlightLoads: Map<string, Promise<LoadMcpResult>>` returns the same in-flight promise for repeat calls.
- **Atomic rollback** — failures during connect / initialize / catalog query call `registry.deleteOne(name)` and re-throw; the lazy entry stays in `LazyRegistry` for retry. No host notifications fire on a failed load.
- **Auth-required failures bypass the retry budget.** `isAuthRequiredError(error)` (from `src/auth`) short-circuits the failure counter in the catch block. Auth failures are operator-actionable (run `dynmcp login`); counting them against the budget would evict an MCP the user just needs to authenticate, silently. See SPEC.md § "Upstream OAuth > Proxy Runtime Behavior".
- **Commit phase** — `lazyRegistry.take(name)`, populate `toolsByMcp`/routers, `rebuildToolCatalog()`, emit the appropriate `notifyXListChanged` calls.

The `runLoadPipeline` calls only execute after the registry connect succeeds. The catalog rebuild and notifications happen only on the commit phase, so a failure mid-pipeline cannot leak half-populated state to the host.

## Server-initiated requests (upstream → host)

The `UpstreamClient` registers request handlers on its SDK `Client` for `sampling/createMessage`, `elicitation/create`, and `roots/list`. Each handler invokes a forwarder on the `Orchestrator`, which calls `ProxyServer.forwardX(params, options)`, which in turn calls the matching method on the SDK `Server` (`createMessage`, `elicitInput`, `listRoots`). The upstream's `extra.signal` is threaded through `options.signal` so cancellation by the upstream cancels the host call.

## Progress forwarding

When the host issues a request with a `progressToken` in `_meta`, the proxy forwards every progress notification the upstream emits for that request back to the host under the host's original token. Implementation:

1. Each `ProxyServer` request handler calls `buildCallOptions(request, extra)` to construct the per-call options object.
2. `buildCallOptions` extracts `request.params._meta?.progressToken`. If present, it wires an `onprogress` callback that re-emits `notifications/progress` to the host via `extra.sendNotification`, preserving the host's token.
3. The options flow `ProxyCallOptions` → `CallOptions` → `UpstreamCallOptions` → SDK `RequestOptions`. The SDK Client auto-assigns its own progress token for the upstream side and routes upstream-emitted progress events into our `onprogress` callback, which fires the host-side notification.

The proxy never sees or rewrites the upstream's auto-assigned token — translation happens purely at the host boundary. `ping` is handled internally by the SDK.

## Things worth knowing if you touch this

- **`buildServer()` vs `start()` on `ProxyServer`**. `start()` is the production entry — it builds the SDK Server and connects it to a `StdioServerTransport`. `buildServer()` returns the SDK Server before connection so tests can pair it with an `InMemoryTransport` for end-to-end protocol exercise without spawning a stdio process.
- **`ProxyServer.catalog` is a function**, not a static reference. This lets the proxy regenerate the `discover_tool` description on the fly after an upstream emits `tools/list_changed`. Tests must pass `() => catalog` rather than the catalog directly.
- **The orchestrator's `toolCatalog` is rebuilt** in `handleToolsListChanged`. Don't cache the reference elsewhere — always go through `orchestrator.catalog` (or the function reference held by `ProxyServer`).
- **The orchestrator's `notificationHandlers` and `serverRequestForwarders` are set after `connect()` returns** but before any upstream traffic can reach them (the only path from upstream to these callbacks is through SDK message dispatch, which happens on later event-loop ticks). If you ever start handling notifications during connect, that ordering will need to change.

import process from "node:process";
import type { Prompt, Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";
import { KeychainStore, isAuthRequiredError } from "../auth/index.js";
import { loadConfig, type LoadConfigOptions } from "../config/index.js";
import type { McpConfig } from "../config/schema.js";
import { createTransport } from "../proxy/transport-factory.js";
import { UpstreamClient, type UpstreamTool } from "../proxy/upstream-client.js";
import { humanizeDuration, truncate } from "./format.js";

const DESCRIPTION_MAX_LENGTH = 100;
const DEFAULT_TIMEOUT_MS = 15_000;

type StepStatus = "ok" | "fail";

type Step = {
  label: string;
  status: StepStatus;
  error?: string;
};

type AuthSummary =
  | { kind: "n/a" }
  | { kind: "header" }
  | {
      kind: "oauth";
      status: "valid" | "missing";
      expiresInSeconds?: number;
    };

/**
 * Per-MCP test result. The JSON output shape mirrors this directly.
 */
export type TestResult = {
  name: string;
  result: "PASS" | "FAIL";
  transport: "stdio" | "streamable-http" | "sse";
  endpoint: string;
  auth: AuthSummary;
  capabilities?: Record<string, unknown>;
  tools?: Array<{ name: string; description: string }>;
  resources?: Array<{ uri: string; name: string; description?: string }>;
  resource_templates?: Array<{ uriTemplate: string; name: string; description?: string }>;
  prompts?: Array<{ name: string; description?: string }>;
  steps: Step[];
  fail_reason?: string;
};

export interface TestOptions extends LoadConfigOptions {
  /** Single-MCP mode if provided; otherwise all-MCP mode. */
  mcpName?: string;
  /** Emit JSON instead of the formatted text output. */
  json?: boolean;
  /** Per-MCP timeout (covers transport open + handshake + all catalog queries). */
  timeoutMs?: number;
  /** Override the output writer (for tests). Defaults to `process.stdout.write`. */
  write?: (chunk: string) => void;
  /** Override the current time (Unix seconds), used to compute token expiry display. */
  now?: () => number;
}

/**
 * Implementation of `dynmcp test [name]`. When `mcpName` is provided, tests one
 * upstream and prints its full discovered surface; otherwise sequentially tests all
 * configured upstreams and prints a per-MCP summary line.
 *
 * Returns the exit code the CLI should propagate: `0` if all probed MCPs passed,
 * `1` otherwise.
 */
export async function test(options: TestOptions = {}): Promise<0 | 1> {
  const config = loadConfig({
    configPath: options.configPath,
    envFilePath: options.envFilePath,
  });
  const write = options.write ?? ((chunk: string) => void process.stdout.write(chunk));
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (options.mcpName !== undefined) {
    return runSingle(config, options.mcpName, {
      write,
      now,
      timeoutMs,
      json: options.json === true,
    });
  }
  return runAll(config, { write, now, timeoutMs, json: options.json === true });
}

type RunOptions = {
  write: (chunk: string) => void;
  now: () => number;
  timeoutMs: number;
  json: boolean;
};

async function runSingle(config: McpConfig, mcpName: string, options: RunOptions): Promise<0 | 1> {
  const entry = config.mcp[mcpName];
  if (entry === undefined) {
    const available = Object.keys(config.mcp).sort().join(", ");
    throw new Error(`Unknown MCP "${mcpName}". Configured MCPs: ${available || "(none)"}.`);
  }

  if (!options.json) {
    options.write(`Testing "${mcpName}" (${entry.transport}, ${endpointForEntry(entry)})\n`);
  }
  const result = await probeOne(mcpName, entry, options.timeoutMs, options.now);

  if (options.json) {
    options.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const step of result.steps) {
      options.write(`  [${step.status}] ${step.label}\n`);
      if (step.error !== undefined) {
        options.write(`    -> ${step.error}\n`);
      }
    }
    renderDiscoveredSurface(options.write, result);
    options.write(`Result: ${result.result}\n`);
  }

  return result.result === "PASS" ? 0 : 1;
}

async function runAll(config: McpConfig, options: RunOptions): Promise<0 | 1> {
  const names = Object.keys(config.mcp);
  const total = names.length;
  if (!options.json) {
    options.write(`Testing all configured upstreams (${total})...\n\n`);
  }

  const results: TestResult[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    const entry = config.mcp[name]!;
    if (!options.json) {
      options.write(`[${index + 1}/${total}] ${name} (${entry.transport}) ... `);
    }
    const result = await probeOne(name, entry, options.timeoutMs, options.now);
    results.push(result);
    if (!options.json) {
      if (result.result === "PASS") {
        const counts = `${result.tools?.length ?? 0} tools, ${
          (result.resources?.length ?? 0) + (result.resource_templates?.length ?? 0)
        } resources, ${result.prompts?.length ?? 0} prompts`;
        options.write(`PASS (${counts})\n`);
      } else {
        options.write(`FAIL (${result.fail_reason ?? "unknown"})\n`);
      }
    }
  }

  const passed = results.filter(r => r.result === "PASS").length;
  const failed = results.length - passed;

  if (options.json) {
    const payload = { summary: { passed, failed }, results };
    options.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    options.write(`\nSummary: ${passed} passed, ${failed} failed\n`);
  }

  return failed === 0 ? 0 : 1;
}

/**
 * Runs the per-MCP probe pipeline: gathers auth status, opens transport, completes
 * `initialize`, fetches the advertised catalogs, and disconnects. Each milestone is
 * recorded as a {@link Step}. Returns a fully-populated {@link TestResult} regardless
 * of pass/fail — failures attach a `fail_reason` and the last attempted step records
 * the underlying error.
 *
 * A timeout wraps the entire pipeline; if it fires, the partial client is disconnected
 * and the result is marked FAIL with a timeout message.
 */
async function probeOne(
  mcpName: string,
  entry: McpConfig["mcp"][string],
  timeoutMs: number,
  now: () => number,
): Promise<TestResult> {
  const result: TestResult = {
    name: mcpName,
    result: "PASS",
    transport: entry.transport,
    endpoint: endpointForEntry(entry),
    auth: deriveAuthSummary(mcpName, entry, now),
    steps: [],
  };

  // Surface the auth status as the first step (informational; never fails).
  if (entry.transport !== "stdio") {
    result.steps.push({ label: authStepLabel(result.auth), status: "ok" });
  }

  // Holder pattern: TypeScript's flow analysis cannot track assignments made inside
  // the async closure, so a plain `let client: UpstreamClient | null` ends up
  // narrowed to `null` in the `finally` block. A holder object sidesteps that —
  // property access never gets narrowed to `never`.
  const clientHolder: { value: UpstreamClient | null } = { value: null };
  let timeoutHandle: NodeJS.Timeout | undefined;

  const run = (async () => {
    const transport = createTransport(mcpName, entry);
    const client = new UpstreamClient({
      name: mcpName,
      transport,
      onTransportError: () => {
        // Swallow during diagnostic — the connect/initialize promise will reject with detail.
      },
    });
    clientHolder.value = client;
    await client.connect();
    result.steps.push({ label: "Connected and initialized", status: "ok" });

    const caps = client.getCapabilities();
    result.capabilities = caps as Record<string, unknown> | undefined;
    result.steps.push({
      label: `Capabilities: ${describeCapabilities(caps)}`,
      status: "ok",
    });

    const tools = await client.listTools();
    result.tools = tools.map((tool: UpstreamTool) => ({
      name: tool.name,
      description: tool.description,
    }));
    result.steps.push({
      label: `tools/list returned ${tools.length} tool${tools.length === 1 ? "" : "s"}`,
      status: "ok",
    });

    let resources: Resource[] = [];
    let templates: ResourceTemplate[] = [];
    if (caps?.resources !== undefined) {
      try {
        resources = await client.listResources();
        templates = await client.listResourceTemplates();
        result.resources = resources.map(r => {
          const out: { uri: string; name: string; description?: string } = {
            uri: r.uri,
            name: r.name,
          };
          if (r.description !== undefined) out.description = r.description;
          return out;
        });
        result.resource_templates = templates.map(t => {
          const out: { uriTemplate: string; name: string; description?: string } = {
            uriTemplate: t.uriTemplate,
            name: t.name,
          };
          if (t.description !== undefined) out.description = t.description;
          return out;
        });
        result.steps.push({
          label: `resources/list returned ${resources.length} resource${resources.length === 1 ? "" : "s"}, ${templates.length} template${templates.length === 1 ? "" : "s"}`,
          status: "ok",
        });
      } catch (error) {
        result.steps.push({
          label: "resources/list",
          status: "fail",
          error: errorMessage(error),
        });
        // Continue — resources failure doesn't block prompts.
      }
    }

    let prompts: Prompt[] = [];
    if (caps?.prompts !== undefined) {
      try {
        prompts = await client.listPrompts();
        result.prompts = prompts.map(p => {
          const out: { name: string; description?: string } = { name: p.name };
          if (p.description !== undefined) out.description = p.description;
          return out;
        });
        result.steps.push({
          label: `prompts/list returned ${prompts.length} prompt${prompts.length === 1 ? "" : "s"}`,
          status: "ok",
        });
      } catch (error) {
        result.steps.push({
          label: "prompts/list",
          status: "fail",
          error: errorMessage(error),
        });
      }
    }
  })();

  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new TestTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    await Promise.race([run, timeout]);
  } catch (error) {
    result.result = "FAIL";
    result.fail_reason = failReason(error, mcpName);
    result.steps.push({
      label: `aborted: ${result.fail_reason}`,
      status: "fail",
      error: errorMessage(error),
    });
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    const connected = clientHolder.value;
    if (connected !== null) {
      try {
        await connected.disconnect();
      } catch {
        // Best-effort cleanup — disconnect failures during a diagnostic aren't worth surfacing.
      }
    }
  }

  // Any per-step failure beyond the first informational step counts as overall FAIL.
  if (result.result === "PASS" && result.steps.some(s => s.status === "fail")) {
    result.result = "FAIL";
    const failed = result.steps.find(s => s.status === "fail");
    result.fail_reason = failed?.error ?? failed?.label ?? "unknown";
  }

  return result;
}

class TestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Test timed out after ${timeoutMs}ms`);
    this.name = "TestTimeoutError";
  }
}

function endpointForEntry(entry: McpConfig["mcp"][string]): string {
  if (entry.transport === "stdio") {
    const args = (entry.args ?? []).join(" ");
    return args.length > 0 ? `${entry.command} ${args}` : entry.command;
  }
  return entry.url;
}

function deriveAuthSummary(
  mcpName: string,
  entry: McpConfig["mcp"][string],
  now: () => number,
): AuthSummary {
  if (entry.transport === "stdio") return { kind: "n/a" };

  const keychain = new KeychainStore(mcpName, entry.url);
  const blob = keychain.get();
  if (blob !== undefined) {
    return {
      kind: "oauth",
      status: "valid",
      expiresInSeconds: blob.expires_at - now(),
    };
  }
  const hasHeader =
    entry.headers !== undefined &&
    Object.keys(entry.headers).some(k => k.toLowerCase() === "authorization");
  if (hasHeader) return { kind: "header" };
  return { kind: "oauth", status: "missing" };
}

function authStepLabel(auth: AuthSummary): string {
  switch (auth.kind) {
    case "n/a":
      return "(no auth applicable)";
    case "header":
      return "Static Authorization header present";
    case "oauth":
      if (auth.status === "missing") return "No cached OAuth token";
      return `OAuth token present (expires in ${humanizeDuration(auth.expiresInSeconds ?? 0)})`;
  }
}

function describeCapabilities(caps: Record<string, unknown> | undefined): string {
  if (caps === undefined) return "(none advertised)";
  const parts: string[] = [];
  for (const [name, value] of Object.entries(caps)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object" && Object.keys(value).length > 0) {
      const flags = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v === true)
        .map(([k]) => k)
        .join(",");
      parts.push(flags.length > 0 ? `${name}(${flags})` : name);
    } else {
      parts.push(name);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "(none advertised)";
}

function failReason(error: unknown, mcpName: string): string {
  if (isAuthRequiredError(error)) {
    return `auth required: run \`dynmcp login ${mcpName}\``;
  }
  if (error instanceof TestTimeoutError) return error.message;
  if (error instanceof Error) return error.message.split("\n")[0] ?? "unknown error";
  return String(error);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function renderDiscoveredSurface(write: (chunk: string) => void, result: TestResult): void {
  if (result.result !== "PASS") return;

  const sections: Array<[string, (() => void) | undefined]> = [
    [
      `Tools (${result.tools?.length ?? 0})`,
      result.tools && result.tools.length > 0
        ? () => {
            const sorted = [...(result.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name));
            for (const tool of sorted) {
              write(`  - ${tool.name}: ${truncate(tool.description, DESCRIPTION_MAX_LENGTH)}\n`);
            }
          }
        : undefined,
    ],
    [
      `Resources (${result.resources?.length ?? 0})`,
      result.resources && result.resources.length > 0
        ? () => {
            const sorted = [...(result.resources ?? [])].sort((a, b) => a.uri.localeCompare(b.uri));
            for (const r of sorted) {
              const tail = r.description ?? r.name;
              write(`  - ${r.uri}: ${truncate(tail, DESCRIPTION_MAX_LENGTH)}\n`);
            }
          }
        : undefined,
    ],
    [
      `Resource templates (${result.resource_templates?.length ?? 0})`,
      result.resource_templates && result.resource_templates.length > 0
        ? () => {
            const sorted = [...(result.resource_templates ?? [])].sort((a, b) =>
              a.uriTemplate.localeCompare(b.uriTemplate),
            );
            for (const t of sorted) {
              const tail = t.description ?? t.name;
              write(`  - ${t.uriTemplate}: ${truncate(tail, DESCRIPTION_MAX_LENGTH)}\n`);
            }
          }
        : undefined,
    ],
    [
      `Prompts (${result.prompts?.length ?? 0})`,
      result.prompts && result.prompts.length > 0
        ? () => {
            const sorted = [...(result.prompts ?? [])].sort((a, b) => a.name.localeCompare(b.name));
            for (const p of sorted) {
              const tail = p.description ?? "";
              write(
                `  - ${p.name}${tail.length > 0 ? `: ${truncate(tail, DESCRIPTION_MAX_LENGTH)}` : ""}\n`,
              );
            }
          }
        : undefined,
    ],
  ];

  for (const [header, render] of sections) {
    if (render === undefined) continue;
    write(`\n${header}:\n`);
    render();
  }
}

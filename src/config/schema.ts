import { z } from "zod";

export const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const mcpName = z.string().regex(MCP_NAME_PATTERN);

export const envModeSchema = z
  .enum(["enable", "dotenv", "process", "disable"])
  .describe(
    'Controls environment variable interpolation in config values. "enable" (default) merges .env and process.env (.env wins). "dotenv" loads .env only. "process" uses process.env only. "disable" turns interpolation off.',
  );

export type EnvMode = z.infer<typeof envModeSchema>;

/**
 * Optional per-entry description. When present (and non-whitespace), the MCP becomes
 * a lazy upstream and the proxy enables dynamic discovery. The string is shown to the
 * agent in the `<mcp_servers>` block of `discover_tool`'s description so the agent
 * can decide whether to invoke `load_mcp` for it. The `.refine` runs after env-var
 * interpolation, so values that resolve to whitespace-only are also rejected.
 */
const description = z
  .string()
  .min(1, { message: "description must be a non-empty string" })
  .refine(value => value.trim().length > 0, {
    message: "description must not be whitespace-only",
  })
  .optional();

const stdioTransport = z
  .object({
    transport: z.literal("stdio"),
    description,
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const httpUrl = z
  .string()
  .url()
  .refine(u => u.startsWith("http://") || u.startsWith("https://"), {
    message: "URL must use http:// or https:// scheme",
  });

const streamableHttpTransport = z
  .object({
    transport: z.literal("streamable-http"),
    description,
    url: httpUrl,
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const sseTransport = z
  .object({
    transport: z.literal("sse"),
    description,
    url: httpUrl,
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const transportConfig = z.discriminatedUnion("transport", [
  stdioTransport,
  streamableHttpTransport,
  sseTransport,
]);

export const mcpConfigSchema = z.object({
  env: envModeSchema.optional(),
  mcp: z
    .record(mcpName, transportConfig)
    .refine(obj => Object.keys(obj).length > 0, { message: "At least one MCP must be configured" }),
});

export type McpConfig = z.infer<typeof mcpConfigSchema>;

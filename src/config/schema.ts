import { z } from "zod";

export const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const mcpName = z.string().regex(MCP_NAME_PATTERN);

export const envModeSchema = z
  .enum(["enable", "dotenv", "process", "disable"])
  .describe(
    'Controls environment variable interpolation in config values. "enable" (default) merges .env and process.env (.env wins). "dotenv" loads .env only. "process" uses process.env only. "disable" turns interpolation off.',
  );

export type EnvMode = z.infer<typeof envModeSchema>;

const stdioTransport = z
  .object({
    transport: z.literal("stdio"),
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
    url: httpUrl,
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const sseTransport = z
  .object({
    transport: z.literal("sse"),
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

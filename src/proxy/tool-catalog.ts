import type { UpstreamTool } from "./upstream-client.js";

const DISCOVER_TOOL_PREAMBLE = `Use this tool to look up the full schema of a tool before calling it with use_tool.
Call discover_tool with a tool name from the list below to get its complete description,
input parameters, and output schema. Always discover a tool before using it.`;

const DYNAMIC_DISCOVERY_PREAMBLE = `Some MCP servers below are not loaded yet and are listed under <mcp_servers> with a
short description of what they do. To make a server's tools (and any resources or
prompts it exposes) available, call load_mcp with its name. Once loaded, the server's
tools will appear in the <tools> list and become callable via use_tool. Loading is
permanent for the remainder of this session.`;

const NO_TOOLS_LOADED_FOOTER =
  "No tools are currently loaded. Call load_mcp to make a server's tools available.";

export class ToolCatalog {
  readonly tools: ReadonlyMap<string, UpstreamTool>;
  readonly discoverToolDescription: string;

  private constructor(tools: Map<string, UpstreamTool>, description: string) {
    this.tools = tools;
    this.discoverToolDescription = description;
  }

  static fromFlat(upstreamTools: UpstreamTool[]): ToolCatalog {
    const toolMap = new Map<string, UpstreamTool>();
    for (const tool of upstreamTools) {
      toolMap.set(tool.name, tool);
    }
    const description = buildFlatDescription(upstreamTools);
    return new ToolCatalog(toolMap, description);
  }

  static fromGrouped(groups: Map<string, UpstreamTool[]>): ToolCatalog {
    return ToolCatalog.fromGroupedWithLazy(groups, new Map());
  }

  /**
   * Same as {@link fromGrouped} but additionally accepts a map of lazy upstream MCPs
   * (those declared with a `description` field but not yet loaded). When the map is
   * non-empty, the rendered `discover_tool` description includes a `<mcp_servers>`
   * block listing them with their descriptions and an explanatory paragraph telling
   * the agent how to call `load_mcp`. When `groups` is empty, the `<tools>` block is
   * omitted in favor of a trailing sentence directing the agent to `load_mcp`.
   */
  static fromGroupedWithLazy(
    groups: Map<string, UpstreamTool[]>,
    lazyDescriptions: ReadonlyMap<string, string>,
  ): ToolCatalog {
    const toolMap = new Map<string, UpstreamTool>();
    for (const [mcpName, tools] of groups) {
      for (const tool of tools) {
        toolMap.set(`${mcpName}/${tool.name}`, tool);
      }
    }
    const description = buildGroupedDescription(groups, lazyDescriptions);
    return new ToolCatalog(toolMap, description);
  }

  getToolDetails(toolName: string): string {
    const tool = this.tools.get(toolName);

    if (tool === undefined) {
      const sortedNames = [...this.tools.keys()].sort().join(", ");
      return `Unknown tool: "${toolName}". Available tools: ${sortedNames}`;
    }

    return buildToolDetailsString(toolName, tool);
  }
}

function buildFlatDescription(tools: UpstreamTool[]): string {
  const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const toolLines = sortedTools.map(tool => `- ${tool.name}: ${tool.description}`).join("\n");

  return `${DISCOVER_TOOL_PREAMBLE}\n\n<tools>\n${toolLines}\n</tools>`;
}

function buildGroupedDescription(
  groups: Map<string, UpstreamTool[]>,
  lazyDescriptions: ReadonlyMap<string, string>,
): string {
  const parts: string[] = [DISCOVER_TOOL_PREAMBLE];

  if (lazyDescriptions.size > 0) {
    parts.push(DYNAMIC_DISCOVERY_PREAMBLE);
    parts.push(buildMcpServersBlock(lazyDescriptions));
  }

  if (groups.size > 0) {
    parts.push(buildToolsBlock(groups));
  } else if (lazyDescriptions.size > 0) {
    parts.push(NO_TOOLS_LOADED_FOOTER);
  } else {
    // No eager tools and no lazy MCPs — render an empty <tools> block to keep the
    // shape consistent with the non-dynamic case where the host expected a block.
    parts.push("<tools>\n</tools>");
  }

  return parts.join("\n\n");
}

function buildToolsBlock(groups: Map<string, UpstreamTool[]>): string {
  const sortedMcpNames = [...groups.keys()].sort();
  const sections = sortedMcpNames.map(mcpName => {
    const tools = groups.get(mcpName)!;
    const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    const toolLines = sortedTools
      .map(tool => `- ${mcpName}/${tool.name}: ${tool.description}`)
      .join("\n");
    return `${mcpName}:\n${toolLines}`;
  });

  return `<tools>\n${sections.join("\n\n")}\n</tools>`;
}

function buildMcpServersBlock(lazyDescriptions: ReadonlyMap<string, string>): string {
  // Preserve insertion order (config-file order) rather than sorting alphabetically,
  // so the user's config layout is what the agent sees.
  const lines = [...lazyDescriptions].map(([name, desc]) => `- ${name}: ${desc}`).join("\n");
  return `<mcp_servers>\n${lines}\n</mcp_servers>`;
}

function buildToolDetailsString(displayName: string, tool: UpstreamTool): string {
  const lines: string[] = [
    `Tool: ${displayName}`,
    `Description: ${tool.description}`,
    "",
    "Input Schema:",
    JSON.stringify(tool.inputSchema, null, 2),
  ];

  if (tool.outputSchema !== undefined) {
    lines.push("", "Output Schema:", JSON.stringify(tool.outputSchema, null, 2));
  }

  const annotationLines = buildAnnotationLines(tool);
  if (annotationLines.length > 0) {
    lines.push("", "Annotations:", ...annotationLines);
  }

  return lines.join("\n");
}

function buildAnnotationLines(tool: UpstreamTool): string[] {
  if (tool.annotations === undefined) {
    return [];
  }

  const { annotations } = tool;
  const lines: string[] = [];

  if (annotations.title !== undefined) {
    lines.push(`- title: ${annotations.title}`);
  }
  if (annotations.readOnlyHint !== undefined) {
    lines.push(`- readOnlyHint: ${annotations.readOnlyHint}`);
  }
  if (annotations.destructiveHint !== undefined) {
    lines.push(`- destructiveHint: ${annotations.destructiveHint}`);
  }
  if (annotations.idempotentHint !== undefined) {
    lines.push(`- idempotentHint: ${annotations.idempotentHint}`);
  }
  if (annotations.openWorldHint !== undefined) {
    lines.push(`- openWorldHint: ${annotations.openWorldHint}`);
  }

  return lines;
}

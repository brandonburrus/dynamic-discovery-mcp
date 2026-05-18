import type { UpstreamTool } from "./upstream-client.js";

const DISCOVER_TOOL_PREAMBLE = `Use this tool to look up the full schema of a tool before calling it with use_tool.
Call discover_tool with a tool name from the list below to get its complete description,
input parameters, and output schema. Always discover a tool before using it.`;

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
    const toolMap = new Map<string, UpstreamTool>();
    for (const [mcpName, tools] of groups) {
      for (const tool of tools) {
        toolMap.set(`${mcpName}/${tool.name}`, tool);
      }
    }
    const description = buildGroupedDescription(groups);
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

function buildGroupedDescription(groups: Map<string, UpstreamTool[]>): string {
  const sortedMcpNames = [...groups.keys()].sort();
  const sections = sortedMcpNames.map(mcpName => {
    const tools = groups.get(mcpName)!;
    const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    const toolLines = sortedTools
      .map(tool => `- ${mcpName}/${tool.name}: ${tool.description}`)
      .join("\n");
    return `${mcpName}:\n${toolLines}`;
  });

  return `${DISCOVER_TOOL_PREAMBLE}\n\n<tools>\n${sections.join("\n\n")}\n</tools>`;
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

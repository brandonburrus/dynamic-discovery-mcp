import { describe, expect, it } from "vitest";
import { ToolCatalog } from "../../src/proxy/tool-catalog.js";
import type { UpstreamTool } from "../../src/proxy/upstream-client.js";

const toolA: UpstreamTool = {
  name: "browser_navigate",
  description: "Navigate the browser to a URL",
  inputSchema: { type: "object", properties: { url: { type: "string" } } },
};

const toolB: UpstreamTool = {
  name: "browser_screenshot",
  description: "Take a screenshot",
  inputSchema: { type: "object" },
  outputSchema: { type: "object", properties: { data: { type: "string" } } },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

const fixtures: UpstreamTool[] = [toolA, toolB];

describe("ToolCatalog", () => {
  describe("discoverToolDescription", () => {
    it("contains the <tools> wrapper", () => {
      const catalog = ToolCatalog.fromFlat(fixtures);
      expect(catalog.discoverToolDescription).toContain("<tools>");
      expect(catalog.discoverToolDescription).toContain("</tools>");
    });

    it("lists both tools as '- <name>: <description>' bullet lines", () => {
      const catalog = ToolCatalog.fromFlat(fixtures);
      expect(catalog.discoverToolDescription).toContain(
        `- browser_navigate: Navigate the browser to a URL`,
      );
      expect(catalog.discoverToolDescription).toContain(`- browser_screenshot: Take a screenshot`);
    });

    it("lists tools in alphabetical order (browser_navigate before browser_screenshot)", () => {
      // Pass in reverse order to confirm sorting is applied
      const catalog = ToolCatalog.fromFlat([toolB, toolA]);
      const navigateIndex = catalog.discoverToolDescription.indexOf("browser_navigate");
      const screenshotIndex = catalog.discoverToolDescription.indexOf("browser_screenshot");
      expect(navigateIndex).toBeLessThan(screenshotIndex);
    });
  });

  describe("getToolDetails", () => {
    it("returns a string containing the tool name and description for a known tool", () => {
      const catalog = ToolCatalog.fromFlat(fixtures);
      const details = catalog.getToolDetails("browser_navigate");
      expect(details).toContain("browser_navigate");
      expect(details).toContain("Navigate the browser to a URL");
    });

    it("includes 'Output Schema:' when the tool has an outputSchema", () => {
      const catalog = ToolCatalog.fromFlat(fixtures);
      const details = catalog.getToolDetails("browser_screenshot");
      expect(details).toContain("Output Schema:");
    });

    it("includes annotation key-value lines when the tool has annotations", () => {
      const catalog = ToolCatalog.fromFlat(fixtures);
      const details = catalog.getToolDetails("browser_screenshot");
      expect(details).toContain("readOnlyHint: true");
      expect(details).toContain("openWorldHint: false");
    });

    it("does NOT include 'Output Schema:' when the tool has no outputSchema", () => {
      const catalog = ToolCatalog.fromFlat(fixtures);
      const details = catalog.getToolDetails("browser_navigate");
      expect(details).not.toContain("Output Schema:");
    });

    it("returns a string containing 'Unknown tool:' for an unknown name", () => {
      const catalog = ToolCatalog.fromFlat(fixtures);
      const details = catalog.getToolDetails("nonexistent_tool");
      expect(details).toContain("Unknown tool:");
    });

    it("lists available tool names in the error string for an unknown name", () => {
      const catalog = ToolCatalog.fromFlat(fixtures);
      const details = catalog.getToolDetails("nonexistent_tool");
      expect(details).toContain("browser_navigate");
      expect(details).toContain("browser_screenshot");
    });
  });

  describe("fromGroupedWithLazy", () => {
    const groupedTool: UpstreamTool = {
      name: "navigate",
      description: "Go somewhere",
      inputSchema: { type: "object", properties: {} },
    };

    it("renders only <tools> (no <mcp_servers>) when there are no lazy entries", () => {
      const groups = new Map([["chrome", [groupedTool]]]);
      const catalog = ToolCatalog.fromGroupedWithLazy(groups, new Map());

      expect(catalog.discoverToolDescription).not.toContain("<mcp_servers>");
      expect(catalog.discoverToolDescription).toContain("<tools>");
      // Bullets are bare tool names under a group header; the namespace prefix lives
      // on the group line above each section.
      expect(catalog.discoverToolDescription).toContain("chrome:");
      expect(catalog.discoverToolDescription).toContain("- navigate: Go somewhere");
    });

    it("renders both <mcp_servers> and <tools> in mixed mode", () => {
      const groups = new Map([["filesystem", [{ ...groupedTool, name: "read_file" }]]]);
      const lazy = new Map([
        ["chrome", "Browser automation"],
        ["jira", "Ticket tracking"],
      ]);
      const catalog = ToolCatalog.fromGroupedWithLazy(groups, lazy);

      expect(catalog.discoverToolDescription).toContain("<mcp_servers>");
      expect(catalog.discoverToolDescription).toContain("- chrome: Browser automation");
      expect(catalog.discoverToolDescription).toContain("- jira: Ticket tracking");
      expect(catalog.discoverToolDescription).toContain("<tools>");
      expect(catalog.discoverToolDescription).toContain("filesystem:");
      expect(catalog.discoverToolDescription).toContain("- read_file:");
    });

    it("preserves config-file (insertion) order for the <mcp_servers> block", () => {
      // Insertion order: jira, chrome, filesystem. Confirm that order is preserved
      // rather than collapsed to alphabetical.
      const lazy = new Map([
        ["jira", "J"],
        ["chrome", "C"],
        ["filesystem", "F"],
      ]);
      const catalog = ToolCatalog.fromGroupedWithLazy(new Map(), lazy);

      const desc = catalog.discoverToolDescription;
      const jiraIdx = desc.indexOf("jira:");
      const chromeIdx = desc.indexOf("chrome:");
      const filesystemIdx = desc.indexOf("filesystem:");

      expect(jiraIdx).toBeGreaterThan(-1);
      expect(chromeIdx).toBeGreaterThan(jiraIdx);
      expect(filesystemIdx).toBeGreaterThan(chromeIdx);
    });

    it("omits the <tools> block and appends the load_mcp footer when only lazy entries exist", () => {
      const lazy = new Map([["chrome", "Browser"]]);
      const catalog = ToolCatalog.fromGroupedWithLazy(new Map(), lazy);

      expect(catalog.discoverToolDescription).toContain("<mcp_servers>");
      // Check for the absence of the closing tag — the explanatory paragraph mentions
      // the word "<tools>" in prose, so the substring alone is a false positive.
      expect(catalog.discoverToolDescription).not.toContain("</tools>");
      expect(catalog.discoverToolDescription).toContain(
        "No tools are currently loaded. Call load_mcp",
      );
    });

    it("includes the explanatory paragraph telling the agent about load_mcp", () => {
      const lazy = new Map([["chrome", "Browser"]]);
      const catalog = ToolCatalog.fromGroupedWithLazy(new Map(), lazy);

      expect(catalog.discoverToolDescription).toContain(
        "Some MCP servers below are not loaded yet",
      );
      expect(catalog.discoverToolDescription).toContain("call load_mcp with its name");
    });

    it("post-load: a previously-lazy MCP appears under <tools> and is gone from <mcp_servers>", () => {
      // Simulates the orchestrator's state after `loadMcp('chrome')` succeeds:
      // - chrome's tools are now in `groups`
      // - chrome is no longer in `lazyDescriptions` (lazyRegistry.take removed it)
      const groups = new Map([["chrome", [{ ...groupedTool, name: "browser_navigate" }]]]);
      const lazy = new Map([["jira", "Tickets"]]);
      const catalog = ToolCatalog.fromGroupedWithLazy(groups, lazy);

      expect(catalog.discoverToolDescription).toContain("chrome:");
      expect(catalog.discoverToolDescription).toContain("- browser_navigate:");
      expect(catalog.discoverToolDescription).not.toMatch(/chrome:\s+Browser/);
      // jira still listed as lazy.
      expect(catalog.discoverToolDescription).toContain("- jira: Tickets");
    });

    it("namespaced tool names from lazy-loaded MCPs are addressable via the tools map", () => {
      const groups = new Map([["chrome", [groupedTool]]]);
      const catalog = ToolCatalog.fromGroupedWithLazy(groups, new Map());

      expect(catalog.tools.has("chrome/navigate")).toBe(true);
      expect(catalog.tools.has("navigate")).toBe(false);
    });

    it("fromGrouped delegates to fromGroupedWithLazy with an empty lazy map", () => {
      const groups = new Map([["chrome", [groupedTool]]]);
      const viaShortcut = ToolCatalog.fromGrouped(groups);
      const viaLong = ToolCatalog.fromGroupedWithLazy(groups, new Map());

      expect(viaShortcut.discoverToolDescription).toBe(viaLong.discoverToolDescription);
    });
  });
});

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
      const catalog = new ToolCatalog(fixtures);
      expect(catalog.discoverToolDescription).toContain("<tools>");
      expect(catalog.discoverToolDescription).toContain("</tools>");
    });

    it("lists both tools as '- <name>: <description>' bullet lines", () => {
      const catalog = new ToolCatalog(fixtures);
      expect(catalog.discoverToolDescription).toContain(
        `- browser_navigate: Navigate the browser to a URL`,
      );
      expect(catalog.discoverToolDescription).toContain(`- browser_screenshot: Take a screenshot`);
    });

    it("lists tools in alphabetical order (browser_navigate before browser_screenshot)", () => {
      // Pass in reverse order to confirm sorting is applied
      const catalog = new ToolCatalog([toolB, toolA]);
      const navigateIndex = catalog.discoverToolDescription.indexOf("browser_navigate");
      const screenshotIndex = catalog.discoverToolDescription.indexOf("browser_screenshot");
      expect(navigateIndex).toBeLessThan(screenshotIndex);
    });
  });

  describe("getToolDetails", () => {
    it("returns a string containing the tool name and description for a known tool", () => {
      const catalog = new ToolCatalog(fixtures);
      const details = catalog.getToolDetails("browser_navigate");
      expect(details).toContain("browser_navigate");
      expect(details).toContain("Navigate the browser to a URL");
    });

    it("includes 'Output Schema:' when the tool has an outputSchema", () => {
      const catalog = new ToolCatalog(fixtures);
      const details = catalog.getToolDetails("browser_screenshot");
      expect(details).toContain("Output Schema:");
    });

    it("includes annotation key-value lines when the tool has annotations", () => {
      const catalog = new ToolCatalog(fixtures);
      const details = catalog.getToolDetails("browser_screenshot");
      expect(details).toContain("readOnlyHint: true");
      expect(details).toContain("openWorldHint: false");
    });

    it("does NOT include 'Output Schema:' when the tool has no outputSchema", () => {
      const catalog = new ToolCatalog(fixtures);
      const details = catalog.getToolDetails("browser_navigate");
      expect(details).not.toContain("Output Schema:");
    });

    it("returns a string containing 'Unknown tool:' for an unknown name", () => {
      const catalog = new ToolCatalog(fixtures);
      const details = catalog.getToolDetails("nonexistent_tool");
      expect(details).toContain("Unknown tool:");
    });

    it("lists available tool names in the error string for an unknown name", () => {
      const catalog = new ToolCatalog(fixtures);
      const details = catalog.getToolDetails("nonexistent_tool");
      expect(details).toContain("browser_navigate");
      expect(details).toContain("browser_screenshot");
    });
  });
});

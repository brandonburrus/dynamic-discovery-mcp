import type { Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { ResourceRouter } from "../../src/proxy/resource-router.js";

const fileA: Resource = { uri: "file:///a", name: "A" };
const fileB: Resource = { uri: "file:///b", name: "B" };
const fileC: Resource = { uri: "file:///c", name: "C" };

const fileTemplate: ResourceTemplate = {
  uriTemplate: "file:///{path}",
  name: "Filesystem",
};
const httpTemplate: ResourceTemplate = {
  uriTemplate: "https://api.example.com/{endpoint}",
  name: "HTTP API",
};

describe("ResourceRouter", () => {
  describe("aggregation", () => {
    it("concatenates resources from each upstream in config-file order", () => {
      const router = new ResourceRouter(["first", "second"]);
      router.setResources("first", [fileA]);
      router.setResources("second", [fileB, fileC]);

      const result = router.aggregatedResources();
      expect(result.map(r => r.uri)).toEqual(["file:///a", "file:///b", "file:///c"]);
    });

    it("concatenates templates from each upstream in config-file order", () => {
      const router = new ResourceRouter(["first", "second"]);
      router.setTemplates("first", [fileTemplate]);
      router.setTemplates("second", [httpTemplate]);

      const result = router.aggregatedTemplates();
      expect(result.map(t => t.uriTemplate)).toEqual([
        "file:///{path}",
        "https://api.example.com/{endpoint}",
      ]);
    });

    it("returns empty arrays before any upstream sets data", () => {
      const router = new ResourceRouter(["first"]);
      expect(router.aggregatedResources()).toEqual([]);
      expect(router.aggregatedTemplates()).toEqual([]);
    });
  });

  describe("ownerOf — concrete URIs", () => {
    it("returns the owning upstream for a known URI", () => {
      const router = new ResourceRouter(["fs", "web"]);
      router.setResources("fs", [fileA]);
      router.setResources("web", [{ uri: "https://example.com", name: "Example" }]);

      expect(router.ownerOf("file:///a")).toBe("fs");
      expect(router.ownerOf("https://example.com")).toBe("web");
    });

    it("returns undefined for an unknown URI with no template match", () => {
      const router = new ResourceRouter(["fs"]);
      router.setResources("fs", [fileA]);

      expect(router.ownerOf("file:///unknown")).toBeUndefined();
    });
  });

  describe("ownerOf — templates (prefix match)", () => {
    it("matches a URI against a template's literal prefix", () => {
      const router = new ResourceRouter(["fs"]);
      router.setTemplates("fs", [fileTemplate]);

      expect(router.ownerOf("file:///some/path/foo.txt")).toBe("fs");
    });

    it("returns undefined when no template prefix matches", () => {
      const router = new ResourceRouter(["fs"]);
      router.setTemplates("fs", [fileTemplate]);

      expect(router.ownerOf("https://example.com/foo")).toBeUndefined();
    });

    it("does not match against a template with empty literal prefix", () => {
      const router = new ResourceRouter(["broken"]);
      router.setTemplates("broken", [{ uriTemplate: "{anything}", name: "broken" }]);

      expect(router.ownerOf("file:///foo")).toBeUndefined();
    });
  });

  describe("ownerOf — precedence", () => {
    it("prefers a concrete URI match over a template prefix match, even across upstreams", () => {
      const router = new ResourceRouter(["templated", "concrete"]);
      router.setTemplates("templated", [fileTemplate]);
      router.setResources("concrete", [fileA]);

      expect(router.ownerOf("file:///a")).toBe("concrete");
    });

    it("falls back to template match when concrete URI is not registered", () => {
      const router = new ResourceRouter(["templated", "concrete"]);
      router.setTemplates("templated", [fileTemplate]);
      router.setResources("concrete", [fileA]);

      expect(router.ownerOf("file:///other")).toBe("templated");
    });
  });

  describe("collisions", () => {
    it("records a collision when two upstreams advertise the same URI; first-wins by config order", () => {
      const router = new ResourceRouter(["first", "second"]);
      router.setResources("first", [fileA]);
      router.setResources("second", [{ uri: "file:///a", name: "Duplicate A" }]);

      expect(router.ownerOf("file:///a")).toBe("first");
      expect(router.collisions()).toEqual([
        { uri: "file:///a", chosen: "first", shadowed: "second" },
      ]);
    });

    it("records no collision when URIs are distinct across upstreams", () => {
      const router = new ResourceRouter(["a", "b"]);
      router.setResources("a", [fileA]);
      router.setResources("b", [fileB]);

      expect(router.collisions()).toHaveLength(0);
    });

    it("rebuilds collisions when setResources is called again", () => {
      const router = new ResourceRouter(["first", "second"]);
      router.setResources("first", [fileA]);
      router.setResources("second", [{ uri: "file:///a", name: "Duplicate A" }]);
      expect(router.collisions()).toHaveLength(1);

      router.setResources("second", [fileB]);
      expect(router.collisions()).toHaveLength(0);
    });
  });

  describe("setResources / setTemplates", () => {
    it("rejects an unknown mcpName", () => {
      const router = new ResourceRouter(["known"]);
      expect(() => router.setResources("ghost", [])).toThrow(/unknown mcp/);
      expect(() => router.setTemplates("ghost", [])).toThrow(/unknown mcp/);
    });

    it("replaces previously registered resources rather than appending", () => {
      const router = new ResourceRouter(["fs"]);
      router.setResources("fs", [fileA, fileB]);
      router.setResources("fs", [fileC]);

      expect(router.aggregatedResources().map(r => r.uri)).toEqual(["file:///c"]);
    });
  });
});

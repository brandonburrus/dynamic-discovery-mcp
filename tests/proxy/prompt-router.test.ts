import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { PromptRouter } from "../../src/proxy/prompt-router.js";

const summarize: Prompt = { name: "summarize", description: "Summarize text" };
const translate: Prompt = { name: "translate", description: "Translate text" };
const explain: Prompt = { name: "explain", description: "Explain a concept" };

describe("PromptRouter", () => {
  describe("aggregation", () => {
    it("concatenates prompts from each upstream in config-file order", () => {
      const router = new PromptRouter(["a", "b"]);
      router.setPrompts("a", [summarize]);
      router.setPrompts("b", [translate, explain]);

      expect(router.aggregatedPrompts().map(p => p.name)).toEqual([
        "summarize",
        "translate",
        "explain",
      ]);
    });

    it("returns an empty array before any upstream sets data", () => {
      const router = new PromptRouter(["a"]);
      expect(router.aggregatedPrompts()).toEqual([]);
    });
  });

  describe("ownerOf", () => {
    it("returns the owning mcpName for a registered prompt", () => {
      const router = new PromptRouter(["a", "b"]);
      router.setPrompts("a", [summarize]);
      router.setPrompts("b", [translate]);

      expect(router.ownerOf("summarize")).toBe("a");
      expect(router.ownerOf("translate")).toBe("b");
    });

    it("returns undefined for an unknown prompt name", () => {
      const router = new PromptRouter(["a"]);
      router.setPrompts("a", [summarize]);

      expect(router.ownerOf("ghost")).toBeUndefined();
    });
  });

  describe("collisions", () => {
    it("records a collision; first-wins by config order", () => {
      const router = new PromptRouter(["first", "second"]);
      router.setPrompts("first", [summarize]);
      router.setPrompts("second", [{ name: "summarize", description: "Another summarize" }]);

      expect(router.ownerOf("summarize")).toBe("first");
      expect(router.collisions()).toEqual([
        { name: "summarize", chosen: "first", shadowed: "second" },
      ]);
    });

    it("records no collision when names are distinct", () => {
      const router = new PromptRouter(["a", "b"]);
      router.setPrompts("a", [summarize]);
      router.setPrompts("b", [translate]);

      expect(router.collisions()).toHaveLength(0);
    });

    it("rebuilds collisions when setPrompts is called again", () => {
      const router = new PromptRouter(["a", "b"]);
      router.setPrompts("a", [summarize]);
      router.setPrompts("b", [{ name: "summarize", description: "Dup" }]);
      expect(router.collisions()).toHaveLength(1);

      router.setPrompts("b", [translate]);
      expect(router.collisions()).toHaveLength(0);
    });
  });

  describe("setPrompts", () => {
    it("rejects an unknown mcpName", () => {
      const router = new PromptRouter(["known"]);
      expect(() => router.setPrompts("ghost", [])).toThrow(/unknown mcp/);
    });

    it("replaces previously registered prompts rather than appending", () => {
      const router = new PromptRouter(["a"]);
      router.setPrompts("a", [summarize, translate]);
      router.setPrompts("a", [explain]);

      expect(router.aggregatedPrompts().map(p => p.name)).toEqual(["explain"]);
    });
  });
});

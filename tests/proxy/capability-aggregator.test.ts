import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { aggregateCapabilities } from "../../src/proxy/capability-aggregator.js";

describe("aggregateCapabilities", () => {
  describe("tools (always-on)", () => {
    it("advertises tools and tools.listChanged even when no upstreams exist", () => {
      const result = aggregateCapabilities([]);
      expect(result.tools).toBeDefined();
      expect(result.tools?.listChanged).toBe(true);
    });

    it("advertises tools.listChanged=true even if no upstream supports the notification", () => {
      const result = aggregateCapabilities([{ tools: {} }]);
      expect(result.tools?.listChanged).toBe(true);
    });

    it("advertises tools.listChanged=true when an upstream does support the notification", () => {
      const result = aggregateCapabilities([{ tools: { listChanged: true } }]);
      expect(result.tools?.listChanged).toBe(true);
    });
  });

  describe("resources", () => {
    it("does not advertise resources when no upstream supports it", () => {
      const result = aggregateCapabilities([{ tools: {} }]);
      expect(result.resources).toBeUndefined();
    });

    it("advertises resources when any upstream supports it", () => {
      const result = aggregateCapabilities([{ tools: {} }, { resources: {} }]);
      expect(result.resources).toBeDefined();
    });

    it("ORs resources.subscribe across upstreams", () => {
      const supportsSubscribe: ServerCapabilities = { resources: { subscribe: true } };
      const noSubscribe: ServerCapabilities = { resources: {} };

      expect(aggregateCapabilities([noSubscribe]).resources?.subscribe).toBeUndefined();
      expect(aggregateCapabilities([supportsSubscribe]).resources?.subscribe).toBe(true);
      expect(aggregateCapabilities([noSubscribe, supportsSubscribe]).resources?.subscribe).toBe(
        true,
      );
    });

    it("ORs resources.listChanged across upstreams", () => {
      const supportsListChanged: ServerCapabilities = { resources: { listChanged: true } };
      const noListChanged: ServerCapabilities = { resources: {} };

      expect(aggregateCapabilities([noListChanged]).resources?.listChanged).toBeUndefined();
      expect(aggregateCapabilities([supportsListChanged]).resources?.listChanged).toBe(true);
      expect(
        aggregateCapabilities([noListChanged, supportsListChanged]).resources?.listChanged,
      ).toBe(true);
    });
  });

  describe("prompts", () => {
    it("does not advertise prompts when no upstream supports it", () => {
      const result = aggregateCapabilities([{ tools: {} }]);
      expect(result.prompts).toBeUndefined();
    });

    it("advertises prompts when any upstream supports it", () => {
      const result = aggregateCapabilities([{ prompts: {} }]);
      expect(result.prompts).toBeDefined();
    });

    it("ORs prompts.listChanged across upstreams", () => {
      const result = aggregateCapabilities([{ prompts: {} }, { prompts: { listChanged: true } }]);
      expect(result.prompts?.listChanged).toBe(true);
    });
  });

  describe("logging", () => {
    it("does not advertise logging when no upstream supports it", () => {
      expect(aggregateCapabilities([{ tools: {} }]).logging).toBeUndefined();
    });

    it("advertises logging when any upstream supports it", () => {
      expect(aggregateCapabilities([{ logging: {} }]).logging).toBeDefined();
    });
  });

  describe("completions", () => {
    it("does not advertise completions when no upstream supports it", () => {
      expect(aggregateCapabilities([{ tools: {} }]).completions).toBeUndefined();
    });

    it("advertises completions when any upstream supports it", () => {
      expect(aggregateCapabilities([{ completions: {} }]).completions).toBeDefined();
    });
  });

  describe("undefined upstream capabilities", () => {
    it("ignores undefined entries safely", () => {
      const result = aggregateCapabilities([undefined, { resources: { subscribe: true } }]);
      expect(result.resources?.subscribe).toBe(true);
    });
  });

  describe("full aggregation", () => {
    it("ORs all capabilities across multiple upstreams correctly", () => {
      const upstreamA: ServerCapabilities = {
        tools: { listChanged: true },
        resources: { subscribe: true },
        logging: {},
      };
      const upstreamB: ServerCapabilities = {
        prompts: { listChanged: true },
        resources: { listChanged: true },
        completions: {},
      };

      const result = aggregateCapabilities([upstreamA, upstreamB]);

      expect(result.tools?.listChanged).toBe(true);
      expect(result.resources?.subscribe).toBe(true);
      expect(result.resources?.listChanged).toBe(true);
      expect(result.prompts?.listChanged).toBe(true);
      expect(result.logging).toBeDefined();
      expect(result.completions).toBeDefined();
    });
  });
});

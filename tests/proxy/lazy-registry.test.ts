import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";
import { LazyRegistry } from "../../src/proxy/lazy-registry.js";

function makeTransport(): Transport {
  return {} as Transport;
}

describe("LazyRegistry", () => {
  it("registers and retrieves an entry by name", () => {
    const registry = new LazyRegistry();
    const transport = makeTransport();

    registry.register("chrome", { description: "Browser MCP", transport });

    expect(registry.has("chrome")).toBe(true);
    expect(registry.get("chrome")).toEqual({ description: "Browser MCP", transport });
  });

  it("reports has=false for unregistered names", () => {
    const registry = new LazyRegistry();
    expect(registry.has("unknown")).toBe(false);
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("preserves insertion order in descriptions() and names()", () => {
    const registry = new LazyRegistry();
    registry.register("chrome", { description: "Browser", transport: makeTransport() });
    registry.register("jira", { description: "Tickets", transport: makeTransport() });
    registry.register("filesystem", { description: "Files", transport: makeTransport() });

    expect([...registry.descriptions().keys()]).toEqual(["chrome", "jira", "filesystem"]);
    expect(registry.names()).toEqual(["chrome", "jira", "filesystem"]);
  });

  it("reflects only the description strings in descriptions()", () => {
    const registry = new LazyRegistry();
    registry.register("chrome", { description: "Browser MCP", transport: makeTransport() });
    registry.register("jira", { description: "Jira MCP", transport: makeTransport() });

    expect([...registry.descriptions().entries()]).toEqual([
      ["chrome", "Browser MCP"],
      ["jira", "Jira MCP"],
    ]);
  });

  it("size returns the number of registered entries", () => {
    const registry = new LazyRegistry();
    expect(registry.size()).toBe(0);
    registry.register("a", { description: "A", transport: makeTransport() });
    expect(registry.size()).toBe(1);
    registry.register("b", { description: "B", transport: makeTransport() });
    expect(registry.size()).toBe(2);
  });

  it("take returns and removes the entry; subsequent lookups miss", () => {
    const registry = new LazyRegistry();
    const transport = makeTransport();
    registry.register("chrome", { description: "Browser", transport });

    const taken = registry.take("chrome");

    expect(taken).toEqual({ description: "Browser", transport });
    expect(registry.has("chrome")).toBe(false);
    expect(registry.get("chrome")).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it("take returns undefined for unknown names without mutating state", () => {
    const registry = new LazyRegistry();
    registry.register("a", { description: "A", transport: makeTransport() });

    expect(registry.take("ghost")).toBeUndefined();
    expect(registry.size()).toBe(1);
    expect(registry.has("a")).toBe(true);
  });

  it("throws on duplicate registration to surface config bugs eagerly", () => {
    const registry = new LazyRegistry();
    registry.register("chrome", { description: "Browser", transport: makeTransport() });

    expect(() =>
      registry.register("chrome", { description: "Another", transport: makeTransport() }),
    ).toThrow(/duplicate registration/);
  });

  describe("failure tracking", () => {
    it("failureCount starts at 0 and increments with recordFailure", () => {
      const registry = new LazyRegistry();
      registry.register("chrome", { description: "Browser", transport: makeTransport() });

      expect(registry.failureCount("chrome")).toBe(0);
      expect(registry.recordFailure("chrome")).toBe(1);
      expect(registry.recordFailure("chrome")).toBe(2);
      expect(registry.failureCount("chrome")).toBe(2);
    });

    it("failure counts are scoped per-name", () => {
      const registry = new LazyRegistry();
      registry.register("a", { description: "A", transport: makeTransport() });
      registry.register("b", { description: "B", transport: makeTransport() });

      registry.recordFailure("a");
      registry.recordFailure("a");
      registry.recordFailure("b");

      expect(registry.failureCount("a")).toBe(2);
      expect(registry.failureCount("b")).toBe(1);
    });

    it("take clears the failure count alongside the entry", () => {
      const registry = new LazyRegistry();
      registry.register("chrome", { description: "Browser", transport: makeTransport() });
      registry.recordFailure("chrome");
      registry.recordFailure("chrome");

      registry.take("chrome");

      expect(registry.failureCount("chrome")).toBe(0);
    });

    it("recordFailure on an unregistered name still increments (caller's choice)", () => {
      const registry = new LazyRegistry();
      // No precondition on registration; the orchestrator only calls this for known
      // entries, but the registry itself doesn't gate it.
      expect(registry.recordFailure("ghost")).toBe(1);
    });
  });
});

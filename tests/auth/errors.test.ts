import { describe, expect, it } from "vitest";
import { AuthRequiredError, isAuthRequiredError } from "../../src/auth/errors.js";

describe("AuthRequiredError", () => {
  it("carries the mcp name and produces an actionable message", () => {
    const error = new AuthRequiredError("linear");
    expect(error.mcpName).toBe("linear");
    expect(error.name).toBe("AuthRequiredError");
    expect(error.message).toContain("linear");
    expect(error.message).toContain("dynmcp login linear");
  });
});

describe("isAuthRequiredError", () => {
  it("matches an AuthRequiredError directly", () => {
    expect(isAuthRequiredError(new AuthRequiredError("x"))).toBe(true);
  });

  it("matches when wrapped as a cause", () => {
    const inner = new AuthRequiredError("x");
    const wrapped: Error & { cause?: unknown } = new Error("wrapper");
    wrapped.cause = inner;
    expect(isAuthRequiredError(wrapped)).toBe(true);
  });

  it("matches transitively through multiple cause links", () => {
    const inner = new AuthRequiredError("x");
    const mid: Error & { cause?: unknown } = new Error("mid");
    mid.cause = inner;
    const outer: Error & { cause?: unknown } = new Error("outer");
    outer.cause = mid;
    expect(isAuthRequiredError(outer)).toBe(true);
  });

  it("matches by class name even when class identity differs (e.g. from another bundle)", () => {
    class LookalikeAuthRequiredError extends Error {
      constructor() {
        super("ohai");
        this.name = "AuthRequiredError";
      }
    }
    expect(isAuthRequiredError(new LookalikeAuthRequiredError())).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isAuthRequiredError(new Error("nope"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isAuthRequiredError("string")).toBe(false);
    expect(isAuthRequiredError(null)).toBe(false);
    expect(isAuthRequiredError(undefined)).toBe(false);
    expect(isAuthRequiredError({ message: "x" })).toBe(false);
  });

  it("does not loop forever on a self-referential cause chain", () => {
    const error: Error & { cause?: unknown } = new Error("loop");
    error.cause = error;
    expect(isAuthRequiredError(error)).toBe(false);
  });
});

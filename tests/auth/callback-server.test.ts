import { afterEach, describe, expect, it } from "vitest";
import {
  CallbackOAuthError,
  CallbackServer,
  CallbackTimeoutError,
} from "../../src/auth/callback-server.js";

let server: CallbackServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

async function fetchCallback(
  s: CallbackServer,
  query: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${s.port}${CallbackServer.CALLBACK_PATH}${query}`, init);
}

describe("CallbackServer", () => {
  it("binds an ephemeral port on 127.0.0.1", async () => {
    server = new CallbackServer();
    await server.start();
    expect(server.port).toBeGreaterThan(0);
    expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}/callback`);
  });

  it("captures a valid code+state pair and resolves the awaitCallback promise", async () => {
    server = new CallbackServer();
    await server.start();
    const awaiter = server.awaitCallback(1_000);
    const response = await fetchCallback(server, "?code=the-code&state=the-state");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Authorization complete");
    await expect(awaiter).resolves.toEqual({ code: "the-code", state: "the-state" });
  });

  it("rejects with CallbackTimeoutError when no callback arrives in time", async () => {
    server = new CallbackServer();
    await server.start();
    await expect(server.awaitCallback(20)).rejects.toBeInstanceOf(CallbackTimeoutError);
  });

  it("rejects with CallbackOAuthError when the redirect includes ?error", async () => {
    server = new CallbackServer();
    await server.start();
    const awaiter = server.awaitCallback(1_000);
    // Attach rejection assertion before triggering the request so the rejection
    // is never observed as "unhandled" by Node.
    const assertion = expect(awaiter).rejects.toBeInstanceOf(CallbackOAuthError);
    await fetchCallback(server, "?error=access_denied&error_description=user%20said%20no");
    await assertion;
  });

  it("rejects callbacks missing code or state", async () => {
    server = new CallbackServer();
    await server.start();
    const awaiter = server.awaitCallback(1_000);
    const assertion = expect(awaiter).rejects.toThrow();
    const response = await fetchCallback(server, "?code=only-the-code");
    expect(response.status).toBe(400);
    await assertion;
  });

  it("returns 404 for paths other than /callback", async () => {
    server = new CallbackServer();
    await server.start();
    const response = await fetch(`http://127.0.0.1:${server.port}/somewhere-else`);
    expect(response.status).toBe(404);
  });

  it("returns 405 for non-GET methods", async () => {
    server = new CallbackServer();
    await server.start();
    const response = await fetchCallback(server, "", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("returns 400 when a callback arrives but no awaiter is registered", async () => {
    server = new CallbackServer();
    await server.start();
    const response = await fetchCallback(server, "?code=x&state=y");
    expect(response.status).toBe(400);
  });

  it("only accepts a single callback (second hit returns 400)", async () => {
    server = new CallbackServer();
    await server.start();
    const awaiter = server.awaitCallback(1_000);
    await fetchCallback(server, "?code=a&state=b");
    await awaiter;
    const second = await fetchCallback(server, "?code=c&state=d");
    expect(second.status).toBe(400);
  });

  it("rejects starting an already-started server", async () => {
    server = new CallbackServer();
    await server.start();
    await expect(server.start()).rejects.toThrow();
  });

  it("rejects awaitCallback if start() was not called", async () => {
    const fresh = new CallbackServer();
    await expect(fresh.awaitCallback(100)).rejects.toThrow();
  });

  it("stop() is idempotent", async () => {
    const fresh = new CallbackServer();
    await fresh.start();
    await fresh.stop();
    await expect(fresh.stop()).resolves.toBeUndefined();
  });
});

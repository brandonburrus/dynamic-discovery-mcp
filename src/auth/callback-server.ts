import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The query parameters captured from a successful OAuth redirect to our local
 * callback URL. `state` is the raw value from the authorization server — the caller
 * is responsible for validating it against the value generated when constructing the
 * authorization URL. See SPEC.md § "Upstream OAuth > `dynmcp login`" step 8.
 */
export type CallbackResult = {
  code: string;
  state: string;
};

/**
 * Thrown by {@link CallbackServer.awaitCallback} when no valid callback arrives
 * before the configured timeout elapses. Surfaces as the actionable
 * "browser callback timeout" error path in the spec.
 */
export class CallbackTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for the OAuth callback.`);
    this.name = "CallbackTimeoutError";
  }
}

/**
 * Thrown when the authorization server redirects back with an `error` query
 * parameter instead of `code`. The OAuth 2.0 spec defines the canonical error codes
 * (`access_denied`, `invalid_request`, etc.); we surface whatever the server sent so
 * the user has actionable detail in the terminal.
 */
export class CallbackOAuthError extends Error {
  constructor(
    readonly oauthError: string,
    readonly oauthErrorDescription: string | undefined,
  ) {
    super(
      oauthErrorDescription
        ? `OAuth error from authorization server: ${oauthError} — ${oauthErrorDescription}`
        : `OAuth error from authorization server: ${oauthError}`,
    );
    this.name = "CallbackOAuthError";
  }
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>dynmcp — authorization complete</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 4rem; max-width: 36rem; margin: 0 auto; color: #222; }
      code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 3px; }
    </style>
  </head>
  <body>
    <h1>Authorization complete</h1>
    <p>You may close this tab and return to your terminal.</p>
    <p><small>Issued by <code>dynmcp</code>.</small></p>
  </body>
</html>
`;

const ERROR_HTML_PREFIX = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>dynmcp — authorization failed</title></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 4rem; max-width: 36rem; margin: 0 auto;">
    <h1>Authorization failed</h1>
    <p>`;
const ERROR_HTML_SUFFIX = `</p>
    <p>Return to your terminal for details.</p>
  </body>
</html>
`;

/**
 * One-shot local HTTP server that captures the OAuth authorization-code callback. The
 * server binds to `127.0.0.1` on an OS-assigned ephemeral port (never `0.0.0.0`) and
 * serves a single path (`/callback`) for a single GET request — every other path /
 * method returns `404` / `405`. See SPEC.md § "Upstream OAuth > Local Callback
 * Server" for the full behavior contract.
 *
 * Usage shape:
 *
 * ```
 * const server = new CallbackServer();
 * await server.start();
 * // ... build redirectUri from server.port, kick off auth flow ...
 * const { code, state } = await server.awaitCallback(60_000);
 * await server.stop();
 * ```
 *
 * The server stops itself the instant a valid callback is received, but always call
 * {@link stop} in a `finally` to ensure cleanup on error paths.
 */
export class CallbackServer {
  private server: Server | null = null;
  private boundPort: number | null = null;
  private pending: {
    resolve: (result: CallbackResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  /** The redirect path served. Must match the redirect URI registered with the OAuth client. */
  static readonly CALLBACK_PATH = "/callback";

  /** Begins listening on `127.0.0.1` at an OS-assigned port. */
  async start(): Promise<void> {
    if (this.server !== null) {
      throw new Error("CallbackServer is already started.");
    }

    const server = createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ port: 0, host: "127.0.0.1" });
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Failed to determine bound port for callback server.");
    }
    this.boundPort = (address as AddressInfo).port;
    this.server = server;
  }

  /** The port the OS assigned. Available after {@link start} resolves. */
  get port(): number {
    if (this.boundPort === null) {
      throw new Error("CallbackServer is not started.");
    }
    return this.boundPort;
  }

  /** The full redirect URI to register with the authorization server. */
  get redirectUri(): string {
    return `http://127.0.0.1:${this.port}${CallbackServer.CALLBACK_PATH}`;
  }

  /**
   * Resolves with the captured `code` and `state` once a valid callback is received,
   * or rejects with {@link CallbackTimeoutError} / {@link CallbackOAuthError} on the
   * documented failure paths. Only one callback is accepted; subsequent requests to
   * `/callback` after the first valid hit return `400`.
   */
  awaitCallback(timeoutMs: number): Promise<CallbackResult> {
    if (this.server === null) {
      return Promise.reject(new Error("CallbackServer is not started."));
    }
    if (this.pending !== null) {
      return Promise.reject(new Error("awaitCallback already in progress."));
    }
    return new Promise<CallbackResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new CallbackTimeoutError(timeoutMs));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
    });
  }

  /** Closes the listening socket. Safe to call multiple times. */
  async stop(): Promise<void> {
    if (this.pending !== null) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    if (this.server === null) return;
    await new Promise<void>(resolve => {
      this.server!.close(() => resolve());
    });
    this.server = null;
    this.boundPort = null;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain", allow: "GET" });
      res.end("Method Not Allowed");
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.boundPort ?? 0}`);
    if (url.pathname !== CallbackServer.CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }

    if (this.pending === null) {
      // Late or duplicate request after a successful capture / timeout.
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("No callback expected.");
      return;
    }

    const oauthError = url.searchParams.get("error");
    if (oauthError !== null) {
      const errorDescription = url.searchParams.get("error_description") ?? undefined;
      this.respondError(res, oauthError, errorDescription);
      const { reject, timer } = this.pending;
      clearTimeout(timer);
      this.pending = null;
      reject(new CallbackOAuthError(oauthError, errorDescription));
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code === null || state === null) {
      this.respondError(res, "invalid_callback", "Missing code or state parameter.");
      const { reject, timer } = this.pending;
      clearTimeout(timer);
      this.pending = null;
      reject(new Error("Callback missing code or state parameter."));
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(SUCCESS_HTML);
    const { resolve, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    resolve({ code, state });
  }

  private respondError(res: ServerResponse, errorCode: string, description?: string): void {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    res.end(
      ERROR_HTML_PREFIX +
        escapeHtml(description ?? `OAuth error: ${errorCode}`) +
        ERROR_HTML_SUFFIX,
    );
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

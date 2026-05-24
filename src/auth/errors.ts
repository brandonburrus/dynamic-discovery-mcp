/**
 * Thrown by {@link ProxyOAuthProvider} when the SDK would otherwise redirect the user
 * to an authorization URL or request a PKCE verifier we don't have. The proxy runs
 * over stdio and cannot drive an interactive auth flow; the user must instead run
 * `dynmcp login <name>` from a terminal.
 *
 * The error message is the actionable instruction returned to the agent / surfaced on
 * stderr by callers. See SPEC.md § "Upstream OAuth > Proxy Runtime Behavior".
 */
export class AuthRequiredError extends Error {
  readonly mcpName: string;

  constructor(mcpName: string) {
    super(
      `Upstream MCP "${mcpName}" requires authorization. ` +
        `Run \`dynmcp login ${mcpName}\` from your terminal, then retry.`,
    );
    this.name = "AuthRequiredError";
    this.mcpName = mcpName;
  }
}

/**
 * Returns `true` if `error` is an {@link AuthRequiredError} either directly or as the
 * `cause` of a wrapping error (the MCP SDK wraps provider exceptions inside
 * `UnauthorizedError` during the {@link auth} orchestration). Used by the orchestrator
 * to exempt auth-required failures from the lazy-load retry budget.
 */
export function isAuthRequiredError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof AuthRequiredError) return true;
    if (current instanceof Error && current.name === "AuthRequiredError") return true;
    if (current instanceof Error) {
      current = current.cause;
      continue;
    }
    return false;
  }
  return false;
}

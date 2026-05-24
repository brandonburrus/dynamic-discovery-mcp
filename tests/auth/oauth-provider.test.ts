import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "../../src/auth/errors.js";
import { KeychainStore } from "../../src/auth/keychain-store.js";
import { LoginOAuthProvider, ProxyOAuthProvider } from "../../src/auth/oauth-provider.js";
import { KEYCHAIN_BLOB_VERSION, type KeychainBlob } from "../../src/auth/types.js";

const memory = new Map<string, string>();

vi.mock("@napi-rs/keyring", () => {
  class FakeEntry {
    constructor(
      private readonly service: string,
      private readonly account: string,
    ) {}

    private get key(): string {
      return `${this.service} ${this.account}`;
    }

    getPassword(): string | null {
      return memory.get(this.key) ?? null;
    }

    setPassword(value: string): void {
      memory.set(this.key, value);
    }

    deletePassword(): boolean {
      return memory.delete(this.key);
    }
  }
  return { Entry: FakeEntry };
});

const SERVER_URL = "https://mcp.example.com";

beforeEach(() => {
  memory.clear();
});

function freshBlob(overrides: Partial<KeychainBlob> = {}): KeychainBlob {
  return {
    version: KEYCHAIN_BLOB_VERSION,
    access_token: "current-access",
    token_type: "Bearer",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "current-refresh",
    authorization_server: {
      issuer: "https://issuer.example.com",
      authorization_endpoint: "https://issuer.example.com/authorize",
      token_endpoint: "https://issuer.example.com/token",
    },
    resource_metadata: {
      resource: SERVER_URL,
      authorization_servers: ["https://issuer.example.com"],
    },
    ...overrides,
  };
}

describe("ProxyOAuthProvider", () => {
  it("returns undefined tokens when no keychain entry exists", () => {
    const keychain = new KeychainStore("mcp", SERVER_URL);
    const provider = new ProxyOAuthProvider("mcp", keychain, undefined);
    expect(provider.tokens()).toBeUndefined();
  });

  it("returns cached tokens with an expires_in computed from expires_at", () => {
    const keychain = new KeychainStore("mcp", SERVER_URL);
    const expiresAt = Math.floor(Date.now() / 1000) + 7200;
    keychain.set(freshBlob({ expires_at: expiresAt, access_token: "tok" }));
    const provider = new ProxyOAuthProvider("mcp", keychain, undefined);
    const tokens = provider.tokens()!;
    expect(tokens.access_token).toBe("tok");
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in ?? 0).toBeGreaterThan(7000);
    expect(tokens.expires_in ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(7200);
    expect(tokens.refresh_token).toBe("current-refresh");
  });

  it("treats already-expired tokens as expires_in=0 (forces refresh) without going negative", () => {
    const keychain = new KeychainStore("mcp", SERVER_URL);
    keychain.set(freshBlob({ expires_at: Math.floor(Date.now() / 1000) - 60 }));
    const provider = new ProxyOAuthProvider("mcp", keychain, undefined);
    expect(provider.tokens()?.expires_in).toBe(0);
  });

  it("clientInformation returns the config override when present", () => {
    const keychain = new KeychainStore("mcp", SERVER_URL);
    keychain.set(
      freshBlob({ dcr: { client_id: "cached-dcr-id", client_secret: "cached-secret" } }),
    );
    const provider = new ProxyOAuthProvider("mcp", keychain, {
      client_id: "from-config",
    });
    const info = provider.clientInformation();
    expect(info?.client_id).toBe("from-config");
    expect(info?.client_secret).toBeUndefined();
  });

  it("clientInformation falls back to cached DCR when no config override", () => {
    const keychain = new KeychainStore("mcp", SERVER_URL);
    keychain.set(
      freshBlob({ dcr: { client_id: "cached-dcr-id", client_secret: "cached-secret" } }),
    );
    const provider = new ProxyOAuthProvider("mcp", keychain, undefined);
    const info = provider.clientInformation();
    expect(info?.client_id).toBe("cached-dcr-id");
    expect(info?.client_secret).toBe("cached-secret");
  });

  it("clientInformation returns undefined when neither override nor cache present", () => {
    const keychain = new KeychainStore("mcp", SERVER_URL);
    const provider = new ProxyOAuthProvider("mcp", keychain, undefined);
    expect(provider.clientInformation()).toBeUndefined();
  });

  it("redirectToAuthorization throws AuthRequiredError naming the MCP", () => {
    const keychain = new KeychainStore("mcp", SERVER_URL);
    const provider = new ProxyOAuthProvider("linear", keychain, undefined);
    expect(() => provider.redirectToAuthorization(new URL("https://x"))).toThrow(AuthRequiredError);
    try {
      provider.redirectToAuthorization(new URL("https://x"));
    } catch (error) {
      expect((error as AuthRequiredError).mcpName).toBe("linear");
    }
  });

  it("saveCodeVerifier / codeVerifier throw AuthRequiredError", () => {
    const provider = new ProxyOAuthProvider("mcp", new KeychainStore("mcp", SERVER_URL), undefined);
    expect(() => provider.saveCodeVerifier("xxx")).toThrow(AuthRequiredError);
    expect(() => provider.codeVerifier()).toThrow(AuthRequiredError);
  });

  it("saveTokens merges new tokens into the existing keychain blob atomically", () => {
    const keychain = new KeychainStore("mcp", SERVER_URL);
    keychain.set(freshBlob({ access_token: "old", refresh_token: "old-refresh" }));
    const provider = new ProxyOAuthProvider("mcp", keychain, undefined);
    const newTokens: OAuthTokens = {
      access_token: "new",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "new-refresh",
    };
    provider.saveTokens(newTokens);
    const blob = keychain.get()!;
    expect(blob.access_token).toBe("new");
    expect(blob.refresh_token).toBe("new-refresh");
    expect(blob.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3500);
  });

  it("saveTokens preserves the existing refresh_token when the server didn't issue a new one", () => {
    const keychain = new KeychainStore("mcp", SERVER_URL);
    keychain.set(freshBlob({ refresh_token: "keep-me" }));
    const provider = new ProxyOAuthProvider("mcp", keychain, undefined);
    provider.saveTokens({ access_token: "new", token_type: "Bearer", expires_in: 3600 });
    expect(keychain.get()?.refresh_token).toBe("keep-me");
  });

  it("saveTokens throws AuthRequiredError if the keychain entry is gone", () => {
    const provider = new ProxyOAuthProvider("mcp", new KeychainStore("mcp", SERVER_URL), undefined);
    expect(() =>
      provider.saveTokens({ access_token: "x", token_type: "Bearer", expires_in: 60 }),
    ).toThrow(AuthRequiredError);
  });

  it("discoveryState reconstructs the OAuth metadata snapshot from the keychain", () => {
    const keychain = new KeychainStore("mcp", SERVER_URL);
    keychain.set(
      freshBlob({
        authorization_server: {
          issuer: "https://i.example",
          authorization_endpoint: "https://i.example/a",
          token_endpoint: "https://i.example/t",
          registration_endpoint: "https://i.example/r",
        },
      }),
    );
    const provider = new ProxyOAuthProvider("mcp", keychain, undefined);
    const state = provider.discoveryState();
    expect(state?.authorizationServerUrl).toBe("https://i.example");
    expect(state?.authorizationServerMetadata?.token_endpoint).toBe("https://i.example/t");
    expect(state?.authorizationServerMetadata?.registration_endpoint).toBe("https://i.example/r");
  });

  it("discoveryState returns undefined when no entry is cached", () => {
    expect(
      new ProxyOAuthProvider(
        "mcp",
        new KeychainStore("mcp", SERVER_URL),
        undefined,
      ).discoveryState(),
    ).toBeUndefined();
  });

  it("invalidateCredentials deletes the keychain entry", () => {
    const keychain = new KeychainStore("mcp", SERVER_URL);
    keychain.set(freshBlob());
    const provider = new ProxyOAuthProvider("mcp", keychain, undefined);
    provider.invalidateCredentials("all");
    expect(keychain.get()).toBeUndefined();
  });

  it("clientMetadata advertises 'none' auth method when no client_secret is configured", () => {
    const provider = new ProxyOAuthProvider("mcp", new KeychainStore("mcp", SERVER_URL), undefined);
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none");
  });

  it("clientMetadata advertises 'client_secret_basic' when a client_secret is configured", () => {
    const provider = new ProxyOAuthProvider("mcp", new KeychainStore("mcp", SERVER_URL), {
      client_id: "x",
      client_secret: "s",
    });
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_basic");
  });
});

describe("LoginOAuthProvider", () => {
  function buildProvider(
    overrides: {
      configAuth?: { client_id: string; client_secret?: string; scope?: string };
      redirectUri?: string;
      onAuthorizationUrl?: (url: URL) => Promise<void> | void;
    } = {},
  ): LoginOAuthProvider {
    const onAuthorizationUrl = overrides.onAuthorizationUrl ?? (() => {});
    return new LoginOAuthProvider({
      mcpName: "mcp",
      keychain: new KeychainStore("mcp", SERVER_URL),
      configAuth: overrides.configAuth,
      redirectUri: overrides.redirectUri ?? "http://127.0.0.1:54321/callback",
      callbacks: { onAuthorizationUrl },
    });
  }

  it("clientMetadata includes the redirect URI we bound to", () => {
    const provider = buildProvider({ redirectUri: "http://127.0.0.1:9999/callback" });
    expect(provider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:9999/callback"]);
  });

  it("state() returns a stable value per provider instance", () => {
    const provider = buildProvider();
    const first = provider.state();
    const second = provider.state();
    expect(first).toBe(second);
    expect(provider.currentState).toBe(first);
  });

  it("saveCodeVerifier / codeVerifier round-trip", () => {
    const provider = buildProvider();
    provider.saveCodeVerifier("the-verifier");
    expect(provider.codeVerifier()).toBe("the-verifier");
  });

  it("codeVerifier throws if requested before saveCodeVerifier", () => {
    const provider = buildProvider();
    expect(() => provider.codeVerifier()).toThrow();
  });

  it("clientInformation returns the pending DCR result over the config override", () => {
    const provider = buildProvider({ configAuth: { client_id: "config-id" } });
    const registered: OAuthClientInformationFull = {
      client_id: "fresh-dcr-id",
      client_secret: "fresh-dcr-secret",
      redirect_uris: ["http://127.0.0.1:54321/callback"],
    };
    provider.saveClientInformation(registered);
    const info = provider.clientInformation();
    expect(info?.client_id).toBe("fresh-dcr-id");
    expect(info?.client_secret).toBe("fresh-dcr-secret");
  });

  it("clientInformation falls back to configAuth when no DCR has been saved", () => {
    const provider = buildProvider({
      configAuth: { client_id: "config-id", client_secret: "config-secret" },
    });
    const info = provider.clientInformation();
    expect(info?.client_id).toBe("config-id");
    expect(info?.client_secret).toBe("config-secret");
  });

  it("redirectToAuthorization invokes the onAuthorizationUrl callback", async () => {
    const calls: URL[] = [];
    const provider = buildProvider({
      onAuthorizationUrl: url => {
        calls.push(url);
      },
    });
    await provider.redirectToAuthorization(new URL("https://issuer.example/authorize?x=1"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toString()).toBe("https://issuer.example/authorize?x=1");
  });

  it("saveTokens commits a complete blob to the keychain including pending DCR", () => {
    const keychain = new KeychainStore("mcp", SERVER_URL);
    const provider = new LoginOAuthProvider({
      mcpName: "mcp",
      keychain,
      configAuth: undefined,
      redirectUri: "http://127.0.0.1:54321/callback",
      callbacks: { onAuthorizationUrl: () => {} },
    });

    const discovery: OAuthDiscoveryState = {
      authorizationServerUrl: "https://issuer.example",
      authorizationServerMetadata: {
        issuer: "https://issuer.example",
        authorization_endpoint: "https://issuer.example/a",
        token_endpoint: "https://issuer.example/t",
        registration_endpoint: "https://issuer.example/r",
        response_types_supported: ["code"],
      },
      resourceMetadata: {
        resource: SERVER_URL,
        authorization_servers: ["https://issuer.example"],
      },
    };
    provider.saveDiscoveryState(discovery);
    provider.saveClientInformation({
      client_id: "dcr-id",
      client_secret: "dcr-secret",
      redirect_uris: ["http://127.0.0.1:54321/callback"],
    });
    provider.saveTokens({
      access_token: "the-token",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "refresh",
      scope: "read",
    });

    const blob = keychain.get();
    expect(blob).toBeDefined();
    expect(blob?.access_token).toBe("the-token");
    expect(blob?.refresh_token).toBe("refresh");
    expect(blob?.scope_granted).toBe("read");
    expect(blob?.authorization_server.token_endpoint).toBe("https://issuer.example/t");
    expect(blob?.resource_metadata.resource).toBe(SERVER_URL);
    expect(blob?.dcr?.client_id).toBe("dcr-id");
    expect(blob?.dcr?.client_secret).toBe("dcr-secret");
  });

  it("saveTokens refuses to write if no discovery state was captured", () => {
    const provider = buildProvider();
    expect(() =>
      provider.saveTokens({ access_token: "x", token_type: "Bearer", expires_in: 60 }),
    ).toThrow(/discovery state/i);
  });

  it("discoveryState always returns undefined (force fresh discovery each login)", () => {
    const provider = buildProvider();
    expect(provider.discoveryState()).toBeUndefined();
  });
});

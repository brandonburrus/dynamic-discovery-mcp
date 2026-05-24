import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  KeychainStore,
  buildKeychainAccount,
  KEYCHAIN_SERVICE,
} from "../../src/auth/keychain-store.js";
import { KEYCHAIN_BLOB_VERSION } from "../../src/auth/types.js";

// In-memory backing store the mocked Entry class reads/writes. Keyed by
// `service account` so two stores against the same identity share state.
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

beforeEach(() => {
  memory.clear();
});

function freshBlob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: KEYCHAIN_BLOB_VERSION,
    access_token: "acc-1",
    token_type: "Bearer",
    expires_at: 1_000_000_000,
    refresh_token: "ref-1",
    authorization_server: {
      issuer: "https://issuer.example.com",
      authorization_endpoint: "https://issuer.example.com/authorize",
      token_endpoint: "https://issuer.example.com/token",
    },
    resource_metadata: {
      resource: "https://mcp.example.com",
      authorization_servers: ["https://issuer.example.com"],
    },
    ...overrides,
  };
}

describe("buildKeychainAccount", () => {
  it("combines mcp name and url origin", () => {
    expect(buildKeychainAccount("github", "https://api.githubcopilot.com/mcp/foo")).toBe(
      "github:https://api.githubcopilot.com",
    );
  });

  it("uses port in the origin when non-default", () => {
    expect(buildKeychainAccount("dev", "http://localhost:8443/mcp")).toBe(
      "dev:http://localhost:8443",
    );
  });

  it("rejects invalid URLs", () => {
    expect(() => buildKeychainAccount("x", "not-a-url")).toThrow();
  });
});

describe("KeychainStore", () => {
  it("returns undefined when no entry has been written", () => {
    const store = new KeychainStore("a", "https://x.example");
    expect(store.get()).toBeUndefined();
  });

  it("round-trips a blob through set/get", () => {
    const store = new KeychainStore("a", "https://x.example");
    const blob = freshBlob() as Parameters<typeof store.set>[0];
    store.set(blob);
    expect(store.get()).toEqual(blob);
  });

  it("stamps the version sentinel on every write", () => {
    const store = new KeychainStore("a", "https://x.example");
    store.set({ ...(freshBlob() as Parameters<typeof store.set>[0]), version: 999 as 1 });
    expect(store.get()?.version).toBe(KEYCHAIN_BLOB_VERSION);
  });

  it("returns undefined for blobs from an older / unknown version", () => {
    const store = new KeychainStore("a", "https://x.example");
    // Bypass the typed setter to inject a wrong-version blob the way an old build would.
    const account = buildKeychainAccount("a", "https://x.example");
    memory.set(
      `${KEYCHAIN_SERVICE}\u0000${account}`,
      JSON.stringify({ ...freshBlob(), version: 0 }),
    );
    expect(store.get()).toBeUndefined();
  });

  it("returns undefined for malformed JSON in the keychain", () => {
    const account = buildKeychainAccount("a", "https://x.example");
    memory.set(`${KEYCHAIN_SERVICE}\u0000${account}`, "{not-json");
    expect(new KeychainStore("a", "https://x.example").get()).toBeUndefined();
  });

  it("delete returns true when an entry existed and false otherwise", () => {
    const store = new KeychainStore("a", "https://x.example");
    expect(store.delete()).toBe(false);
    store.set(freshBlob() as Parameters<typeof store.set>[0]);
    expect(store.delete()).toBe(true);
    expect(store.delete()).toBe(false);
    expect(store.get()).toBeUndefined();
  });

  it("scopes entries by mcp name", () => {
    const a = new KeychainStore("a", "https://x.example");
    const b = new KeychainStore("b", "https://x.example");
    a.set({ ...(freshBlob() as Parameters<typeof a.set>[0]), access_token: "for-a" });
    b.set({ ...(freshBlob() as Parameters<typeof b.set>[0]), access_token: "for-b" });
    expect(a.get()?.access_token).toBe("for-a");
    expect(b.get()?.access_token).toBe("for-b");
  });

  it("scopes entries by server origin so re-pointing the URL invalidates the entry", () => {
    const original = new KeychainStore("a", "https://old.example");
    original.set(freshBlob() as Parameters<typeof original.set>[0]);
    const repointed = new KeychainStore("a", "https://new.example");
    expect(repointed.get()).toBeUndefined();
  });

  it("supports a custom service name for test isolation", () => {
    const store = new KeychainStore("a", "https://x.example", "dynmcp-test-only");
    store.set(freshBlob() as Parameters<typeof store.set>[0]);
    expect(new KeychainStore("a", "https://x.example").get()).toBeUndefined();
  });
});

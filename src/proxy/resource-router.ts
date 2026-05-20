import type { Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";

export type ResourceCollision = {
  uri: string;
  chosen: string;
  shadowed: string;
};

/**
 * Tracks which upstream MCP owns each resource URI exposed through the proxy and
 * resolves the owner for any `resources/read`, `resources/subscribe`, or
 * `resources/unsubscribe` request.
 *
 * Collision rule: when two upstreams advertise the same concrete URI, the upstream
 * appearing first in config-file order wins; the shadowed upstream's copy of that
 * resource is unreachable through the proxy until the conflict is resolved upstream.
 *
 * Template URIs (RFC 6570 forms like `file:///{path}`) are matched against incoming
 * URIs by their literal prefix (everything before the first `{`). When more than one
 * upstream advertises an overlapping template, the first-wins rule applies on a
 * prefix-equality basis.
 *
 * Concrete URI matches always take precedence over template matches, regardless of
 * config order.
 */
export class ResourceRouter {
  private readonly mcpOrder: string[];
  private readonly perMcp: Map<string, { resources: Resource[]; templates: ResourceTemplate[] }>;

  private uriOwners: Map<string, string> = new Map();
  private templateOwners: Array<{ prefix: string; template: ResourceTemplate; mcpName: string }> =
    [];
  private detectedCollisions: ResourceCollision[] = [];

  constructor(mcpOrder: readonly string[]) {
    this.mcpOrder = [...mcpOrder];
    this.perMcp = new Map(
      this.mcpOrder.map(name => [name, { resources: [], templates: [] }] as const),
    );
  }

  setResources(mcpName: string, resources: Resource[]): void {
    const entry = this.perMcp.get(mcpName);
    if (entry === undefined) {
      throw new Error(`ResourceRouter: unknown mcp "${mcpName}"`);
    }
    entry.resources = [...resources];
    this.rebuild();
  }

  setTemplates(mcpName: string, templates: ResourceTemplate[]): void {
    const entry = this.perMcp.get(mcpName);
    if (entry === undefined) {
      throw new Error(`ResourceRouter: unknown mcp "${mcpName}"`);
    }
    entry.templates = [...templates];
    this.rebuild();
  }

  aggregatedResources(): Resource[] {
    const result: Resource[] = [];
    for (const mcpName of this.mcpOrder) {
      const entry = this.perMcp.get(mcpName);
      if (entry !== undefined) {
        result.push(...entry.resources);
      }
    }
    return result;
  }

  aggregatedTemplates(): ResourceTemplate[] {
    const result: ResourceTemplate[] = [];
    for (const mcpName of this.mcpOrder) {
      const entry = this.perMcp.get(mcpName);
      if (entry !== undefined) {
        result.push(...entry.templates);
      }
    }
    return result;
  }

  /**
   * Returns the mcpName that owns the given URI, or undefined if no upstream advertises it.
   * Concrete URI matches take precedence over template prefix matches; templates are tried
   * in config-file order (first-wins).
   */
  ownerOf(uri: string): string | undefined {
    const concrete = this.uriOwners.get(uri);
    if (concrete !== undefined) {
      return concrete;
    }

    for (const { prefix, mcpName } of this.templateOwners) {
      if (prefix.length > 0 && uri.startsWith(prefix)) {
        return mcpName;
      }
    }

    return undefined;
  }

  collisions(): readonly ResourceCollision[] {
    return this.detectedCollisions;
  }

  /**
   * Returns the resources contributed by a single upstream MCP. Used by the load_mcp
   * pipeline to construct its structured response, which lists what a just-loaded MCP
   * (or an already-loaded MCP, in the idempotent no-op path) brought to the proxy.
   * Returns an empty array if the MCP has not contributed any resources (or if
   * `mcpName` is unknown).
   */
  resourcesFor(mcpName: string): readonly Resource[] {
    return this.perMcp.get(mcpName)?.resources ?? [];
  }

  templatesFor(mcpName: string): readonly ResourceTemplate[] {
    return this.perMcp.get(mcpName)?.templates ?? [];
  }

  private rebuild(): void {
    this.uriOwners = new Map();
    this.templateOwners = [];
    const collisions: ResourceCollision[] = [];

    for (const mcpName of this.mcpOrder) {
      const entry = this.perMcp.get(mcpName);
      if (entry === undefined) continue;

      for (const resource of entry.resources) {
        const existing = this.uriOwners.get(resource.uri);
        if (existing === undefined) {
          this.uriOwners.set(resource.uri, mcpName);
        } else {
          collisions.push({ uri: resource.uri, chosen: existing, shadowed: mcpName });
        }
      }

      for (const template of entry.templates) {
        this.templateOwners.push({
          prefix: literalPrefixOf(template.uriTemplate),
          template,
          mcpName,
        });
      }
    }

    this.detectedCollisions = collisions;
  }
}

function literalPrefixOf(uriTemplate: string): string {
  const idx = uriTemplate.indexOf("{");
  return idx === -1 ? uriTemplate : uriTemplate.slice(0, idx);
}

import type { Prompt } from "@modelcontextprotocol/sdk/types.js";

export type PromptCollision = {
  name: string;
  chosen: string;
  shadowed: string;
};

/**
 * Tracks which upstream MCP owns each prompt name exposed through the proxy and
 * resolves the owner for any `prompts/get` or `completion/complete` request that
 * references a prompt by name.
 *
 * Collision rule: when two upstreams advertise the same prompt name, the upstream
 * appearing first in config-file order wins; the shadowed upstream's prompt is
 * unreachable through the proxy until the conflict is resolved upstream.
 */
export class PromptRouter {
  private readonly mcpOrder: string[];
  private readonly perMcp: Map<string, Prompt[]>;

  private nameOwners: Map<string, string> = new Map();
  private detectedCollisions: PromptCollision[] = [];

  constructor(mcpOrder: readonly string[]) {
    this.mcpOrder = [...mcpOrder];
    this.perMcp = new Map(this.mcpOrder.map(name => [name, [] as Prompt[]]));
  }

  setPrompts(mcpName: string, prompts: Prompt[]): void {
    const entry = this.perMcp.get(mcpName);
    if (entry === undefined) {
      throw new Error(`PromptRouter: unknown mcp "${mcpName}"`);
    }
    this.perMcp.set(mcpName, [...prompts]);
    this.rebuild();
  }

  aggregatedPrompts(): Prompt[] {
    const result: Prompt[] = [];
    for (const mcpName of this.mcpOrder) {
      const entry = this.perMcp.get(mcpName);
      if (entry !== undefined) {
        result.push(...entry);
      }
    }
    return result;
  }

  ownerOf(promptName: string): string | undefined {
    return this.nameOwners.get(promptName);
  }

  collisions(): readonly PromptCollision[] {
    return this.detectedCollisions;
  }

  private rebuild(): void {
    this.nameOwners = new Map();
    const collisions: PromptCollision[] = [];

    for (const mcpName of this.mcpOrder) {
      const prompts = this.perMcp.get(mcpName);
      if (prompts === undefined) continue;

      for (const prompt of prompts) {
        const existing = this.nameOwners.get(prompt.name);
        if (existing === undefined) {
          this.nameOwners.set(prompt.name, mcpName);
        } else {
          collisions.push({ name: prompt.name, chosen: existing, shadowed: mcpName });
        }
      }
    }

    this.detectedCollisions = collisions;
  }
}

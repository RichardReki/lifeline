/**
 * Thin wrapper over KeeperHub's hosted MCP endpoint.
 *
 * Transport: Streamable HTTP at {baseUrl}/mcp with the org API key sent as a
 * plain "Authorization: Bearer kh_..." header (works headless — no OAuth dance).
 * Exposes ~30 tools incl. search_protocol_actions, execute_protocol_action
 * ("aave-v3/supply" slug form), list_integrations, validate_workflow, etc.
 *
 * NOTE: everything here requires a live kh_ API key — never call connect() in
 * tests or before the key exists.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { KeeperHubConfig } from "../types.js";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export class KeeperHubMcp {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;

  constructor(private readonly config: KeeperHubConfig) {}

  /** Connect to {baseUrl}/mcp. Safe to call twice — the second call is a no-op. */
  async connect(): Promise<void> {
    if (this.client) return;

    const url = new URL("/mcp", this.config.baseUrl.replace(/\/+$/, "") + "/");
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      },
    });
    const client = new Client({ name: "lifeline-agent", version: "0.1.0" });

    try {
      await client.connect(transport);
    } catch (err) {
      // never leak a half-open transport
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
      throw err;
    }

    this.client = client;
    this.transport = transport;
  }

  /** List available tools (name/description/inputSchema), defensively normalized. */
  async listTools(): Promise<McpToolInfo[]> {
    const client = this.requireClient();
    const res = await client.listTools();
    const tools: unknown[] = Array.isArray(res?.tools) ? res.tools : [];
    return tools.flatMap((t): McpToolInfo[] => {
      if (typeof t !== "object" || t === null) return [];
      const rec = t as Record<string, unknown>;
      if (typeof rec.name !== "string") return [];
      return [
        {
          name: rec.name,
          description: typeof rec.description === "string" ? rec.description : undefined,
          inputSchema: rec.inputSchema,
        },
      ];
    });
  }

  /**
   * Call a hosted tool (e.g. "search_protocol_actions", "execute_protocol_action").
   * Returns the raw MCP result — callers inspect .content / .isError themselves.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const client = this.requireClient();
    return client.callTool({ name, arguments: args });
  }

  /** Close client + transport; never throws. */
  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.transport?.close();
    } catch {
      /* ignore */
    }
    this.client = undefined;
    this.transport = undefined;
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new Error("KeeperHubMcp: not connected — call connect() first");
    }
    return this.client;
  }
}

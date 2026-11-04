import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { fetchCatalog, type CatalogAgent } from "./catalog.js";
import { HubClient } from "./client.js";
import type { Config } from "./config.js";

export const VERIFY_TOOL = "verify_provenance";
const REFRESH_AFTER_MS = 10 * 60_000;
const RETRY_AFTER_MS = 30_000;

export const toolNameOf = (agentId: string) => agentId.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64);

const VERIFY_DESCRIPTION =
  "Free. Verify the provenance record (_provenance) the WritersLogic agent hub attaches to every paid result. " +
  "Pass the {data, _provenance} object a paid tool returned, unchanged.";

const verifyTool: Tool = {
  name: VERIFY_TOOL,
  description: VERIFY_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      data: { description: "The result payload, exactly as returned." },
      _provenance: { type: "object", description: "The provenance record, exactly as returned." },
    },
    additionalProperties: true,
  },
  annotations: { title: "Verify provenance", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

function agentTool(name: string, a: CatalogAgent): Tool {
  return {
    name,
    description:
      `${a.title}. ${a.description}\n\nCost: ${a.priceUsdc} USDC per call, paid automatically over x402 on Base ` +
      `when AGENT_PRIVATE_KEY is configured and the price is within MAX_USDC_PER_CALL.`,
    inputSchema: a.inputSchema,
    annotations: { title: a.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  };
}

/** Catalog-backed tool set. Keeps the last good catalog when a refresh fails. */
export class ToolRegistry {
  private tools = new Map<string, CatalogAgent>();
  private loadedAt = 0;
  private failedAt = 0;
  private inflight: Promise<void> | undefined;

  constructor(
    private readonly cfg: Config,
    private readonly log: (msg: string) => void,
  ) {}

  /** Loads the catalog now; concurrent callers share one fetch. Never throws. */
  refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async load(): Promise<void> {
    try {
      const agents = await fetchCatalog(this.cfg.baseUrl, this.cfg.catalogTimeoutMs, this.log);
      const next = new Map<string, CatalogAgent>();
      for (const agent of agents) {
        const name = toolNameOf(agent.id);
        if (name === VERIFY_TOOL || next.has(name)) this.log(`skipping ${agent.id}: tool name "${name}" is taken`);
        else next.set(name, agent);
      }
      this.tools = next;
      this.loadedAt = Date.now();
      this.log(`catalog loaded: ${next.size} agents from ${this.cfg.baseUrl}`);
    } catch (err) {
      this.failedAt = Date.now();
      this.log(`catalog unavailable (${err instanceof Error ? err.message : String(err)}); serving ${this.tools.size} cached agents`);
    }
  }

  /** Waits for a pending load, or starts one when the catalog is empty/stale and a retry is due. */
  async ensureFresh(): Promise<void> {
    const now = Date.now();
    const stale = this.loadedAt === 0 || now - this.loadedAt > REFRESH_AFTER_MS;
    if (this.inflight || (stale && now - this.failedAt > RETRY_AFTER_MS)) await this.refresh();
  }

  list(): Tool[] {
    return [...[...this.tools].map(([name, a]) => agentTool(name, a)), verifyTool];
  }

  get(name: string): CatalogAgent | undefined {
    return this.tools.get(name);
  }
}

export function createServer(cfg: Config, log: (msg: string) => void, version: string) {
  const registry = new ToolRegistry(cfg, log);
  const hub = new HubClient(cfg);
  const server = new Server(
    { name: "writerslogic-ai-agents-mcp", version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "Each tool is a pay-per-call AI agent. Calls cost USDC (see the price in each tool description) and are paid " +
        "automatically up to MAX_USDC_PER_CALL when a wallet is configured. Use verify_provenance to check a result.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await registry.ensureFresh();
    return { tools: registry.list() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return { isError: true, content: [{ type: "text" as const, text: "Tool arguments must be a JSON object" }] };
    }
    if (name === VERIFY_TOOL) {
      const out = await hub.verifyProvenance(args);
      return { isError: out.isError, content: [{ type: "text" as const, text: out.text }] };
    }
    let agent = registry.get(name);
    if (!agent) {
      await registry.ensureFresh();
      agent = registry.get(name);
    }
    if (!agent) return { isError: true, content: [{ type: "text" as const, text: `Unknown tool: ${name}` }] };

    const out = await hub.callAgent(agent, args);
    if (out.payment) log(`paid ${out.payment.amountUsdc} USDC to ${out.payment.payTo} for ${agent.id} (${out.payment.network})`);
    return {
      isError: out.isError,
      content: [{ type: "text" as const, text: out.text }],
      ...(out.payment && { _meta: { "io.github.writerslogic/payment": out.payment } }),
    };
  });

  return { server, registry };
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { fetchCatalog, type CatalogAgent } from "./catalog.js";
import { HubClient } from "./client.js";
import { TOOL_ALIASES, type Config } from "./config.js";
import { describePackage, fetchPackages, packageToolDef, parsePackageArgs, type PackageIndex, type PackageTool } from "./packages.js";

export const VERIFY_TOOL = "verify_provenance";
const REFRESH_AFTER_MS = 10 * 60_000;
const RETRY_AFTER_MS = 30_000;
const MAX_TOOLS = 1000;

type Entry = { kind: "agent"; agent: CatalogAgent } | { kind: "package"; pkg: PackageTool };

/** snake_case for every tool: camelCase ids such as causalReferee become causal_referee, other characters become underscores. */
export const toolNameOf = (agentId: string) =>
  TOOL_ALIASES[agentId] ??
  agentId.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9_]/g, "_").toLowerCase().slice(0, 64);

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

/** Catalog-backed tool set: one tool per agent, or per package for grouped checks. Keeps the last good catalog when a refresh fails. */
export class ToolRegistry {
  private tools = new Map<string, Entry>();
  private index: PackageIndex | undefined;
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
      const [agents, index] = await Promise.all([
        fetchCatalog(this.cfg.baseUrl, this.cfg.catalogTimeoutMs, this.log),
        fetchPackages(this.cfg.baseUrl, this.cfg.catalogTimeoutMs, this.log),
      ]);
      // A transient index failure keeps the last good grouping rather than flipping every check to its own tool.
      if (index) this.index = index;
      this.tools = this.build(agents, this.index);
      this.loadedAt = Date.now();
      const packages = [...this.tools.values()].filter((e) => e.kind === "package").length;
      this.log(`catalog loaded: ${agents.length} agents as ${this.tools.size} tools (${packages} packages) from ${this.cfg.baseUrl}`);
    } catch (err) {
      this.failedAt = Date.now();
      this.log(`catalog unavailable (${err instanceof Error ? err.message : String(err)}); serving ${this.tools.size} cached tools`);
    }
  }

  private build(agents: CatalogAgent[], index: PackageIndex | undefined): Map<string, Entry> {
    const expand = this.cfg.expandPackages;
    const expanded = (id: string) => expand === "all" || expand.has(id);
    if (index && expand !== "all") {
      for (const id of expand) if (!index.packages.has(id)) this.log(`AGENTS_PACKAGES: the hub has no package "${id}"`);
    }
    const batch = index?.batchId ? agents.find((a) => a.id === index.batchId) : undefined;
    const singles: CatalogAgent[] = [];
    const packages = new Map<string, PackageTool>();
    const profile = this.cfg.profile;
    for (const agent of agents) {
      if (profile !== "all" && !profile.has(agent.id) && !(agent.package && profile.has(agent.package))) continue;
      const meta = agent.package ? index?.packages.get(agent.package) : undefined;
      if (!meta || expanded(meta.id)) {
        singles.push(agent);
        continue;
      }
      let pkg = packages.get(meta.id);
      if (!pkg) packages.set(meta.id, (pkg = { meta, members: new Map(), ...(batch && { batch }) }));
      pkg.members.set(agent.id, agent);
    }

    const next = new Map<string, Entry>();
    const add = (id: string, entry: Entry) => {
      const name = toolNameOf(id);
      if (name === VERIFY_TOOL || next.has(name)) this.log(`skipping ${id}: tool name "${name}" is taken`);
      else if (next.size >= MAX_TOOLS) this.log(`skipping ${id}: more than ${MAX_TOOLS} tools`);
      else next.set(name, entry);
    };
    for (const agent of singles) add(agent.id, { kind: "agent", agent });
    for (const pkg of packages.values()) add(pkg.meta.id, { kind: "package", pkg });
    return next;
  }

  /** Waits for a pending load, or starts one when the catalog is empty/stale and a retry is due. */
  async ensureFresh(): Promise<void> {
    const now = Date.now();
    const stale = this.loadedAt === 0 || now - this.loadedAt > REFRESH_AFTER_MS;
    if (this.inflight || (stale && now - this.failedAt > RETRY_AFTER_MS)) await this.refresh();
  }

  list(): Tool[] {
    const tools = [...this.tools].map(([name, e]) => (e.kind === "agent" ? agentTool(name, e.agent) : packageToolDef(name, e.pkg)));
    return [...tools, verifyTool];
  }

  get(name: string): Entry | undefined {
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
    let entry = registry.get(name);
    if (!entry) {
      await registry.ensureFresh();
      entry = registry.get(name);
    }
    if (!entry) return { isError: true, content: [{ type: "text" as const, text: `Unknown tool: ${name}` }] };

    let agent: CatalogAgent;
    let body: unknown = args;
    if (entry.kind === "agent") {
      agent = entry.agent;
    } else {
      const parsed = parsePackageArgs(entry.pkg, args);
      if (typeof parsed === "string") return { isError: true, content: [{ type: "text" as const, text: parsed }] };
      if (parsed.kind === "describe") {
        return { isError: false, content: [{ type: "text" as const, text: await describePackage(entry.pkg, parsed.check, cfg) }] };
      }
      agent = parsed.agent;
      body = parsed.body;
    }

    const out = await hub.callAgent(agent, body);
    if (out.payment) log(`paid ${out.payment.amountUsdc} USDC to ${out.payment.payTo} for ${agent.id} (${out.payment.network})`);
    return {
      isError: out.isError,
      content: [{ type: "text" as const, text: out.text }],
      ...(out.payment && { _meta: { "io.github.writerslogic/payment": out.payment } }),
    };
  });

  return { server, registry };
}

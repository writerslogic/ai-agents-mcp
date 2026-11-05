import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { isRecord, resolveHubUrl, type CatalogAgent } from "./catalog.js";
import { ID_RE, type Config } from "./config.js";
import { MAX_RESPONSE_BYTES, request } from "./http.js";

export const PACKAGES_PATH = "/api/v1/packages";
/** The hub's micro-batch limit. */
export const MAX_BATCH_CALLS = 20;
const MAX_PACKAGES = 100;
const MAX_DESCRIPTION = 8000;
const MAX_SUMMARY = 200;

export interface PackageMeta {
  id: string;
  title: string;
  summary: string;
  /** One-line summary per check id, as the index lists it. */
  summaries: Map<string, string>;
}

export interface PackageIndex {
  packages: Map<string, PackageMeta>;
  /** Catalog id of the agent that runs many checks under one payment. */
  batchId?: string;
}

export interface PackageTool {
  meta: PackageMeta;
  members: Map<string, CatalogAgent>;
  batch?: CatalogAgent;
  /** Example inputs from the package detail view, fetched on the first describe. */
  examples?: Map<string, unknown>;
}

export type PackageRequest =
  | { kind: "describe"; check?: CatalogAgent }
  | { kind: "call"; agent: CatalogAgent; body: Record<string, unknown> };

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The free package index, or undefined when the hub has none (older hubs answer 404) or it is unusable. Never throws. */
export async function fetchPackages(baseUrl: string, timeoutMs: number, warn: (msg: string) => void): Promise<PackageIndex | undefined> {
  const url = resolveHubUrl(baseUrl, PACKAGES_PATH)!;
  let raw: unknown;
  try {
    const res = await request(url, { method: "GET", headers: { accept: "application/json" } }, { timeoutMs, maxBytes: MAX_RESPONSE_BYTES });
    if (res.status === 404) return undefined;
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    raw = JSON.parse(res.text);
  } catch (err) {
    warn(`package index unavailable (${errorText(err)})`);
    return undefined;
  }
  if (!isRecord(raw) || !Array.isArray(raw.packages)) {
    warn("package index has no packages array");
    return undefined;
  }
  const packages = new Map<string, PackageMeta>();
  for (const p of raw.packages.slice(0, MAX_PACKAGES)) {
    if (!isRecord(p) || typeof p.id !== "string" || !ID_RE.test(p.id) || packages.has(p.id)) continue;
    const summaries = new Map<string, string>();
    for (const t of Array.isArray(p.tools) ? p.tools : []) {
      if (isRecord(t) && typeof t.id === "string" && ID_RE.test(t.id)) summaries.set(t.id, text(t.summary, MAX_SUMMARY));
    }
    packages.set(p.id, { id: p.id, title: text(p.title, 200) || p.id, summary: text(p.summary, 1000), summaries });
  }
  const batch = raw.batch;
  const batchId = isRecord(batch) && typeof batch.id === "string" && ID_RE.test(batch.id) ? batch.id : undefined;
  return { packages, ...(batchId && { batchId }) };
}

export function packageToolDef(name: string, pkg: PackageTool): Tool {
  const { meta, members, batch } = pkg;
  const ids = [...members.keys()];
  const usage = [
    "How to call:",
    '- {"describe": true, "check": "<id>"}: free. Returns that check\'s input schema and an example input.',
    '- {"check": "<id>", "input": {...}}: runs one check at its listed price.',
    ...(batch
      ? [`- {"calls": [{"check": "<id>", "input": {...}}, ...]}: up to ${MAX_BATCH_CALLS} checks from this package under one ${batch.priceUsdc} USDC payment. Stateful and network checks are rejected before payment.`]
      : []),
    "Paid calls settle automatically over x402 on Base when AGENT_PRIVATE_KEY is configured and the price is within MAX_USDC_PER_CALL.",
  ].join("\n");
  const head = `${meta.title}.${meta.summary ? ` ${meta.summary}` : ""}\n\nChecks (id, USDC per call, what it does):`;
  let lines = "";
  let listed = 0;
  for (const [id, a] of members) {
    const line = `\n- ${id} (${a.priceUsdc}): ${meta.summaries.get(id) || a.title}`;
    if (head.length + lines.length + line.length + usage.length + 64 > MAX_DESCRIPTION) break;
    lines += line;
    listed++;
  }
  if (listed < members.size) lines += `\n- ...and ${members.size - listed} more (see the check enum).`;

  const check = { type: "string", enum: ids, description: "Check id from this package." };
  const input = { type: "object", description: "The check's own request body. Use describe for its schema.", additionalProperties: true };
  return {
    name,
    description: `${head}${lines}\n\n${usage}`,
    inputSchema: {
      type: "object",
      properties: {
        check,
        input,
        ...(batch && {
          calls: {
            type: "array",
            minItems: 1,
            maxItems: MAX_BATCH_CALLS,
            items: { type: "object", properties: { check, input }, required: ["check", "input"], additionalProperties: false },
          },
        }),
        describe: { type: "boolean", description: "Return the check's input schema and example instead of running it (free)." },
      },
      additionalProperties: false,
    },
    annotations: { title: meta.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  };
}

const ARG_KEYS = new Set(["check", "input", "calls", "describe"]);

function memberOf(pkg: PackageTool, id: unknown, where: string): CatalogAgent | string {
  const agent = typeof id === "string" ? pkg.members.get(id) : undefined;
  if (agent) return agent;
  return `${where} must be one of this package's checks: ${[...pkg.members.keys()].join(", ")}`;
}

/** Validates package-tool arguments locally, so a malformed call never reaches the hub. Returns an error message on failure. */
export function parsePackageArgs(pkg: PackageTool, args: Record<string, unknown> | undefined): PackageRequest | string {
  const a = args ?? {};
  const extra = Object.keys(a).filter((k) => !ARG_KEYS.has(k));
  if (extra.length) return `Unknown argument ${extra.join(", ")}; use check, input, calls or describe.`;
  if (a.describe !== undefined && typeof a.describe !== "boolean") return "describe must be true or false.";

  if (a.describe === true) {
    if (a.check === undefined) return { kind: "describe" };
    const agent = memberOf(pkg, a.check, "check");
    return typeof agent === "string" ? agent : { kind: "describe", check: agent };
  }

  if (a.calls !== undefined) {
    if (a.check !== undefined || a.input !== undefined) return "Pass either calls, or check with input, not both.";
    if (!pkg.batch) return "This hub offers no batch endpoint; call one check at a time with check and input.";
    if (!Array.isArray(a.calls) || a.calls.length < 1 || a.calls.length > MAX_BATCH_CALLS) {
      return `calls must be an array of 1 to ${MAX_BATCH_CALLS} {check, input} objects.`;
    }
    const calls: { tool: string; input: Record<string, unknown> }[] = [];
    for (const [i, c] of a.calls.entries()) {
      if (!isRecord(c) || Object.keys(c).some((k) => k !== "check" && k !== "input")) return `calls[${i}] must be {check, input}.`;
      const agent = memberOf(pkg, c.check, `calls[${i}].check`);
      if (typeof agent === "string") return agent;
      if (!isRecord(c.input)) return `calls[${i}].input must be an object.`;
      calls.push({ tool: agent.id, input: c.input });
    }
    return { kind: "call", agent: pkg.batch, body: { calls } };
  }

  if (a.check === undefined) {
    return 'Pass {"check": "<id>", "input": {...}} to run a check, or {"describe": true, "check": "<id>"} for its schema (free).';
  }
  const agent = memberOf(pkg, a.check, "check");
  if (typeof agent === "string") return agent;
  if (!isRecord(a.input)) return `input must be an object: ${agent.id}'s request body. Use describe for its schema.`;
  return { kind: "call", agent, body: a.input };
}

/** Example inputs from the free package detail view. Never sends payment or API-key headers. */
async function loadExamples(pkg: PackageTool, cfg: Config): Promise<Map<string, unknown> | string> {
  if (pkg.examples) return pkg.examples;
  const url = resolveHubUrl(cfg.baseUrl, `${PACKAGES_PATH}/${pkg.meta.id}`)!;
  try {
    const res = await request(url, { method: "GET", headers: { accept: "application/json" } }, { timeoutMs: cfg.catalogTimeoutMs, maxBytes: MAX_RESPONSE_BYTES });
    if (res.status !== 200) return `HTTP ${res.status}`;
    const raw: unknown = JSON.parse(res.text);
    const examples = new Map<string, unknown>();
    for (const t of isRecord(raw) && Array.isArray(raw.tools) ? raw.tools : []) {
      if (isRecord(t) && typeof t.id === "string" && pkg.members.has(t.id) && t.example !== undefined) examples.set(t.id, t.example);
    }
    pkg.examples = examples;
    return examples;
  } catch (err) {
    return errorText(err);
  }
}

/** Free description of the package, or of one check with its schema and example. */
export async function describePackage(pkg: PackageTool, check: CatalogAgent | undefined, cfg: Config): Promise<string> {
  if (!check) {
    return JSON.stringify(
      {
        package: pkg.meta.id,
        title: pkg.meta.title,
        summary: pkg.meta.summary,
        checks: [...pkg.members.values()].map((a) => ({ id: a.id, title: a.title, priceUsdc: a.priceUsdc, summary: pkg.meta.summaries.get(a.id) ?? "" })),
        ...(pkg.batch && { batch: { priceUsdc: pkg.batch.priceUsdc, maxCalls: MAX_BATCH_CALLS } }),
      },
      null,
      2,
    );
  }
  const examples = await loadExamples(pkg, cfg);
  const example = typeof examples === "string" ? undefined : examples.get(check.id);
  return JSON.stringify(
    {
      check: check.id,
      title: check.title,
      priceUsdc: check.priceUsdc,
      description: check.description,
      inputSchema: check.inputSchema,
      ...(example !== undefined ? { example } : { exampleUnavailable: typeof examples === "string" ? examples : "the hub lists no example" }),
    },
    null,
    2,
  );
}

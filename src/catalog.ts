import { parseUnits } from "ethers";
import { ID_RE, USDC_DECIMALS } from "./config.js";
import { MAX_CATALOG_BYTES, HttpFailure, request } from "./http.js";

/** view=tools is the light catalog; hubs that predate it ignore the query and send the full manifest. */
export const CATALOG_PATH = "/api/v1/catalog?view=tools";
const MAX_ENTRIES = 2000;
const PRICE_RE = /^\d{1,9}(\.\d{1,6})?$/;
const MAX_TEXT = 4000;

export type JsonSchema = { type: "object"; [key: string]: unknown };

export interface CatalogAgent {
  id: string;
  /** Absolute URL, always on the configured hub origin. */
  url: string;
  title: string;
  description: string;
  priceUsdc: string;
  /** Price in USDC base units. */
  priceAtomic: bigint;
  inputSchema: JsonSchema;
  /** Package id when the hub groups this agent into a package tool. */
  package?: string;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Resolves a catalog path against the hub, refusing anything that would leave its origin. */
export function resolveHubUrl(baseUrl: string, path: string): string | undefined {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return undefined;
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, "");
  const url = new URL(`${prefix}${path}`, base.origin);
  return url.origin === base.origin ? url.href : undefined;
}

function toSchema(raw: unknown): JsonSchema {
  if (isRecord(raw) && raw.type === "object") return raw as JsonSchema;
  return { type: "object", additionalProperties: true };
}

/** Untrusted catalog entry to a validated agent, or undefined (with a reason) when unusable. */
export function parseAgent(raw: unknown, baseUrl: string): CatalogAgent | string {
  if (!isRecord(raw)) return "entry is not an object";
  const { id, path, title, description, priceUsdc } = raw;
  if (typeof id !== "string" || !ID_RE.test(id)) return "invalid id";
  if (typeof path !== "string") return `${id}: missing path`;
  const url = resolveHubUrl(baseUrl, path);
  if (!url) return `${id}: path is not on the hub origin`;
  if (typeof priceUsdc !== "string" || !PRICE_RE.test(priceUsdc)) return `${id}: invalid priceUsdc`;
  return {
    id,
    url,
    title: typeof title === "string" ? title.slice(0, 200) : id,
    description: typeof description === "string" ? description.slice(0, MAX_TEXT) : "",
    priceUsdc,
    priceAtomic: parseUnits(priceUsdc, USDC_DECIMALS),
    inputSchema: toSchema(raw.inputSchema),
    ...(typeof raw.package === "string" && ID_RE.test(raw.package) && { package: raw.package }),
  };
}

export async function fetchCatalog(
  baseUrl: string,
  timeoutMs: number,
  warn: (msg: string) => void,
): Promise<CatalogAgent[]> {
  const url = resolveHubUrl(baseUrl, CATALOG_PATH)!;
  const res = await request(url, { method: "GET", headers: { accept: "application/json" } }, { timeoutMs, maxBytes: MAX_CATALOG_BYTES });
  if (res.status !== 200) throw new HttpFailure(`Catalog request returned HTTP ${res.status}`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(res.text);
  } catch {
    throw new HttpFailure("Catalog is not valid JSON");
  }
  if (!isRecord(manifest) || !Array.isArray(manifest.agents)) throw new HttpFailure("Catalog has no agents array");

  const agents: CatalogAgent[] = [];
  const seen = new Set<string>();
  if (manifest.agents.length > MAX_ENTRIES) warn(`catalog has ${manifest.agents.length} entries; using the first ${MAX_ENTRIES}`);
  for (const raw of manifest.agents.slice(0, MAX_ENTRIES)) {
    const agent = parseAgent(raw, baseUrl);
    if (typeof agent === "string") {
      warn(`skipping catalog entry: ${agent}`);
    } else if (seen.has(agent.id)) {
      warn(`skipping duplicate catalog id ${agent.id}`);
    } else {
      seen.add(agent.id);
      agents.push(agent);
    }
  }
  return agents;
}

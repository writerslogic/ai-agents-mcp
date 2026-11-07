import { Wallet, formatUnits, parseUnits } from "ethers";

export const DEFAULT_BASE_URL = "https://agents.writerslogic.com";
export const USDC_DECIMALS = 6;

export interface Config {
  /** Origin plus optional path prefix, no trailing slash. */
  baseUrl: string;
  wallet?: Wallet;
  /** Per-call spending cap in USDC base units. */
  maxPerCall: bigint;
  /** Display form of the cap, as the user wrote it. */
  maxPerCallUsdc: string;
  apiKey?: string;
  catalogTimeoutMs: number;
  callTimeoutMs: number;
  /** Packages whose checks are listed as individual tools instead of one package tool. */
  expandPackages: "all" | ReadonlySet<string>;
  /** Which hub agents become tools: "all", or the set of agent and package ids. Unset means the core web, document and code-security set. */
  profile: "all" | ReadonlySet<string>;
}

/**
 * The default tool set: web, document and code-security tools an assistant uses day to day. The hub lists far more agents
 * (research, legal, crypto, micro-check packages); a client that lists all of them overloads the model's tool choice, so those
 * are opted into with AGENTS_PROFILE.
 */
export const CORE_AGENTS: readonly string[] = [
  "web-search", "page-contents", "page-capture", "doc-to-markdown", "transcribe-url", "redact-text", "company-identity",
  "lead-enrichment", "competitor-battlecard", "pre-merge-review", "unicode-safety-gate", "dependency-advisor", "cra-readiness",
  "cra-exploit-clock",
];

/** Base units to a display string with at least two decimals, e.g. 2000000 -> "2.00". */
export function formatUsdc(atomic: bigint | string): string {
  const s = formatUnits(atomic, USDC_DECIMALS);
  return /\.\d$/.test(s) ? `${s}0` : s;
}

export class ConfigError extends Error {}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const USDC_AMOUNT_RE = /^\d{1,12}(\.\d{1,6})?$/;
const PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

export function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("AGENTS_BASE_URL is not a valid URL");
  }
  const secure = url.protocol === "https:";
  if (!secure && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new ConfigError("AGENTS_BASE_URL must use https (http is allowed only for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError("AGENTS_BASE_URL must not contain credentials, a query string or a fragment");
  }
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

export function parseUsdc(raw: string, name: string): bigint {
  const value = raw.trim();
  if (!USDC_AMOUNT_RE.test(value)) throw new ConfigError(`${name} must be a decimal USDC amount such as "1.00"`);
  return parseUnits(value, USDC_DECIMALS);
}

function parseTimeout(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000 || n > 600_000) {
    throw new ConfigError("AGENTS_TIMEOUT_MS must be an integer between 1000 and 600000");
  }
  return n;
}

/** Agent and package ids as the hub publishes them. */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function parseExpandPackages(raw: string | undefined): "all" | ReadonlySet<string> {
  const value = raw?.trim() ?? "";
  if (value === "all") return "all";
  const ids = value.split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    if (!ID_RE.test(id)) throw new ConfigError('AGENTS_PACKAGES must be "all" or a comma-separated list of package ids');
  }
  return new Set(ids);
}

export function parseProfile(raw: string | undefined): "all" | ReadonlySet<string> {
  const value = raw?.trim() ?? "";
  if (value === "all") return "all";
  if (value === "" || value === "core") return new Set(CORE_AGENTS);
  const ids = value.split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    if (!ID_RE.test(id)) throw new ConfigError('AGENTS_PROFILE must be "core", "all" or a comma-separated list of agent or package ids');
  }
  return new Set(ids);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const maxPerCallUsdc = env.MAX_USDC_PER_CALL?.trim() || "1.00";
  const key = env.AGENT_PRIVATE_KEY?.trim();
  let wallet: Wallet | undefined;
  if (key) {
    // Never echo the key or the underlying parse error.
    if (!PRIVATE_KEY_RE.test(key)) throw new ConfigError("AGENT_PRIVATE_KEY must be a 32-byte hex private key");
    wallet = new Wallet(key.startsWith("0x") ? key : `0x${key}`);
  }
  const callTimeoutMs = parseTimeout(env.AGENTS_TIMEOUT_MS, 120_000);
  return {
    baseUrl: parseBaseUrl(env.AGENTS_BASE_URL?.trim() || DEFAULT_BASE_URL),
    wallet,
    maxPerCall: parseUsdc(maxPerCallUsdc, "MAX_USDC_PER_CALL"),
    maxPerCallUsdc,
    apiKey: env.AGENTS_API_KEY?.trim() || undefined,
    catalogTimeoutMs: Math.min(15_000, callTimeoutMs),
    callTimeoutMs,
    expandPackages: parseExpandPackages(env.AGENTS_PACKAGES),
    profile: parseProfile(env.AGENTS_PROFILE),
  };
}

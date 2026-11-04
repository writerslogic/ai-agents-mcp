import type { CatalogAgent } from "./catalog.js";
import { resolveHubUrl } from "./catalog.js";
import { type Config, formatUsdc } from "./config.js";
import { HttpFailure, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, request, type HttpResult } from "./http.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  parsePaymentRequired,
  selectExact,
  signExact,
  type ExactRequirement,
} from "./payment.js";

export const VERIFY_PROVENANCE_PATH = "/api/v1/verify-provenance";
const MAX_ERROR_BODY = 4000;

export interface Outcome {
  text: string;
  isError: boolean;
  /** Set when a payment authorization was sent with the successful request. */
  payment?: { amountUsdc: string; payer: string; payTo: string; network: string };
}

const fail = (text: string): Outcome => ({ text, isError: true });
const clip = (s: string) => (s.length > MAX_ERROR_BODY ? `${s.slice(0, MAX_ERROR_BODY)}... [truncated]` : s);

function decodeHeaderJson(value: string | null): unknown {
  if (!value || value.length > 16 * 1024) return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function describeRequirement(req: ExactRequirement, agent: CatalogAgent): string {
  return [
    `Price: ${formatUsdc(req.amount)} USDC per call to ${agent.id}`,
    `Network: ${req.network}`,
    `Asset: ${req.asset} (USDC)`,
    `Pay to: ${req.payTo}`,
    `Scheme: x402 "exact" (EIP-3009 transferWithAuthorization, gasless for the payer)`,
  ].join("\n");
}

export class HubClient {
  constructor(private readonly cfg: Config) {}

  get canPay(): boolean {
    return this.cfg.wallet !== undefined;
  }

  private post(url: string, body: string, extra: Record<string, string> = {}): Promise<HttpResult> {
    return request(
      url,
      { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...extra }, body },
      { timeoutMs: this.cfg.callTimeoutMs, maxBytes: MAX_RESPONSE_BYTES },
    );
  }

  private encode(args: unknown): string | Outcome {
    const body = JSON.stringify(args ?? {});
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return fail(`Arguments exceed the ${MAX_REQUEST_BYTES} byte limit`);
    return body;
  }

  private finish(res: HttpResult): Outcome {
    if (res.status >= 200 && res.status < 300) return { text: res.text, isError: false };
    return fail(`HTTP ${res.status}: ${clip(res.text)}`);
  }

  /** Calls a paid agent, paying with an x402 "exact" authorization when the hub asks and the policy allows. */
  async callAgent(agent: CatalogAgent, args: unknown): Promise<Outcome> {
    const body = this.encode(args);
    if (typeof body !== "string") return body;
    const auth: Record<string, string> = this.cfg.apiKey ? { "X-API-KEY": this.cfg.apiKey } : {};
    try {
      const first = await this.post(agent.url, body, auth);
      if (first.status !== 402) return this.finish(first);
      return await this.pay(agent, body, auth, first);
    } catch (err) {
      if (err instanceof HttpFailure) return fail(err.message);
      throw err;
    }
  }

  private async pay(agent: CatalogAgent, body: string, auth: Record<string, string>, challenge: HttpResult): Promise<Outcome> {
    const pr = parsePaymentRequired(challenge.headers.get(PAYMENT_REQUIRED_HEADER));
    const req = pr && selectExact(pr);
    if (!pr || !req) {
      return fail(
        `Payment required (HTTP 402) at the catalog price of ${agent.priceUsdc} USDC, but the hub did not offer a supported ` +
          `x402 v2 "exact" USDC challenge (Base mainnet or Base Sepolia). Nothing was paid.\n${clip(challenge.text)}`,
      );
    }

    const description = describeRequirement(req, agent);
    if (!this.cfg.wallet) {
      return fail(
        `Payment required.\n${description}\n\nNo payment was made. Set AGENT_PRIVATE_KEY to a funded wallet key (USDC on ` +
          `${req.network}; no gas needed) to pay automatically, or set AGENTS_API_KEY if you have an API key. ` +
          `Spending is capped at MAX_USDC_PER_CALL (currently ${this.cfg.maxPerCallUsdc}).`,
      );
    }
    if (BigInt(req.amount) > this.cfg.maxPerCall) {
      return fail(
        `Refused to pay: ${formatUsdc(req.amount)} USDC exceeds MAX_USDC_PER_CALL of ${this.cfg.maxPerCallUsdc}. ` +
          `Raise MAX_USDC_PER_CALL to allow this call.\n${description}`,
      );
    }

    const resource = pr.resource && typeof pr.resource === "object" ? pr.resource : { url: agent.url, mimeType: "application/json" };
    const signed = await signExact(this.cfg.wallet, req, resource);
    const second = await this.post(agent.url, body, { ...auth, [PAYMENT_SIGNATURE_HEADER]: signed.header });

    if (second.status === 402) {
      const settlement = decodeHeaderJson(second.headers.get("payment-response"));
      const reason = settlement && typeof settlement === "object" ? ` Settlement: ${JSON.stringify(settlement)}.` : "";
      return fail(`Payment was not accepted by the hub (HTTP 402).${reason}\n${clip(second.text)}`);
    }
    const outcome = this.finish(second);
    if (!outcome.isError) {
      outcome.payment = {
        amountUsdc: formatUsdc(req.amount),
        payer: signed.from,
        payTo: req.payTo,
        network: req.network,
      };
    } else {
      outcome.text += "\n(A payment authorization was sent with this request; check PAYMENT-RESPONSE or your wallet before retrying.)";
    }
    return outcome;
  }

  /** Free provenance check; never carries payment or API-key headers. */
  async verifyProvenance(args: unknown): Promise<Outcome> {
    const body = this.encode(args);
    if (typeof body !== "string") return body;
    const url = resolveHubUrl(this.cfg.baseUrl, VERIFY_PROVENANCE_PATH)!;
    try {
      const res = await this.post(url, body);
      if (res.status === 402) return fail("The hub asked for payment on the provenance endpoint, which is expected to be free.");
      return this.finish(res);
    } catch (err) {
      if (err instanceof HttpFailure) return fail(err.message);
      throw err;
    }
  }
}

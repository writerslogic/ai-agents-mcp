import { getAddress, hexlify, randomBytes, ZeroAddress, type Wallet } from "ethers";

export const PAYMENT_REQUIRED_HEADER = "payment-required";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";

/**
 * USDC per supported network. A challenge naming any other asset is refused: the
 * spending cap is expressed in USDC, so signing for an unknown token would make it meaningless.
 */
export const USDC_BY_NETWORK: Readonly<Record<string, { chainId: number; asset: string }>> = {
  "eip155:8453": { chainId: 8453, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  "eip155:84532": { chainId: 84532, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
};

export const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const MAX_HEADER_CHARS = 16 * 1024;
const MIN_VALIDITY_S = 30;
const MAX_VALIDITY_S = 3600;

export interface ExactRequirement {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource?: Record<string, unknown>;
  accepts: unknown[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Decodes the base64 PAYMENT-REQUIRED header of an x402 v2 challenge; undefined when absent or unusable. */
export function parsePaymentRequired(header: string | null): PaymentRequired | undefined {
  if (!header || header.length > MAX_HEADER_CHARS) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    if (!isRecord(parsed) || parsed.x402Version !== 2 || !Array.isArray(parsed.accepts)) return undefined;
    return parsed as unknown as PaymentRequired;
  } catch {
    return undefined;
  }
}

function checkExact(raw: unknown): ExactRequirement | undefined {
  if (!isRecord(raw) || raw.scheme !== "exact") return undefined;
  const net = typeof raw.network === "string" ? USDC_BY_NETWORK[raw.network] : undefined;
  if (!net) return undefined;
  const { amount, asset, payTo, maxTimeoutSeconds, extra } = raw;
  if (typeof amount !== "string" || !/^\d{1,30}$/.test(amount)) return undefined;
  if (typeof asset !== "string" || typeof payTo !== "string") return undefined;
  try {
    if (!sameAddress(getAddress(asset), net.asset)) return undefined;
    if (getAddress(payTo) === ZeroAddress) return undefined;
  } catch {
    return undefined;
  }
  if (!Number.isInteger(maxTimeoutSeconds) || (maxTimeoutSeconds as number) <= 0) return undefined;
  if (!isRecord(extra)) return undefined;
  const { name, version, assetTransferMethod } = extra;
  if (typeof name !== "string" || !name || name.length > 64) return undefined;
  if (typeof version !== "string" || !version || version.length > 16) return undefined;
  if (assetTransferMethod !== undefined && assetTransferMethod !== "eip3009") return undefined;
  return raw as ExactRequirement;
}

/** First acceptable `exact` EIP-3009 USDC requirement, or undefined. */
export function selectExact(pr: PaymentRequired): ExactRequirement | undefined {
  for (const raw of pr.accepts) {
    const ok = checkExact(raw);
    if (ok) return ok;
  }
  return undefined;
}

export interface SignedPayment {
  /** Base64 value for the PAYMENT-SIGNATURE header. */
  header: string;
  from: string;
}

/** Signs an EIP-3009 TransferWithAuthorization for exactly `req.amount` and wraps it as an x402 v2 payload. */
export async function signExact(
  wallet: Wallet,
  req: ExactRequirement,
  resource: Record<string, unknown>,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SignedPayment> {
  const net = USDC_BY_NETWORK[req.network]!;
  const authorization = {
    from: wallet.address,
    to: getAddress(req.payTo),
    value: req.amount,
    validAfter: "0",
    validBefore: String(now + Math.min(Math.max(req.maxTimeoutSeconds, MIN_VALIDITY_S), MAX_VALIDITY_S)),
    nonce: hexlify(randomBytes(32)),
  };
  const signature = await wallet.signTypedData(
    { name: req.extra.name, version: req.extra.version, chainId: net.chainId, verifyingContract: getAddress(req.asset) },
    AUTHORIZATION_TYPES,
    authorization,
  );
  const payload = { x402Version: 2, resource, accepted: req, payload: { signature, authorization } };
  return { header: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"), from: wallet.address };
}

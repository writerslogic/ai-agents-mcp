export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 1024 * 1024;

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
}

export class HttpFailure extends Error {}

async function readCapped(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel();
    throw new HttpFailure(`Response exceeds the ${limit} byte limit`);
  }
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) {
      await res.body.cancel();
      throw new HttpFailure(`Response exceeds the ${limit} byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** fetch with a hard timeout, a byte cap on the body, and no redirects (headers could leak to another host). */
export async function request(
  url: string,
  init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string },
  opts: { timeoutMs: number; maxBytes: number },
): Promise<HttpResult> {
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    return { status: res.status, headers: res.headers, text: await readCapped(res, opts.maxBytes) };
  } catch (err) {
    if (err instanceof HttpFailure) throw err;
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new HttpFailure(`Request timed out after ${opts.timeoutMs} ms`);
    }
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
    throw new HttpFailure(`Request failed${cause || (err instanceof Error ? `: ${err.message}` : "")}`);
  }
}

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Wallet, verifyTypedData } from "ethers";
import { fetchCatalog, parseAgent } from "../src/catalog.js";
import { HubClient } from "../src/client.js";
import { loadConfig, parseBaseUrl, parseUsdc, ConfigError } from "../src/config.js";
import { USDC_BASE, PAY_TO, requirementFor, startMockHub, type MockHub, type Route } from "./mockHub.js";

// Independent copy of the EIP-3009 types so the test does not just restate the implementation.
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const wallet = Wallet.createRandom();
const CAP = "1.00";
const LIMIT = 1_000_000;
const routes: Route[] = [
  { path: "/api/v1/agents/pay", amount: "250000" },
  { path: "/api/v1/agents/limit-minus-1", amount: String(LIMIT - 1) },
  { path: "/api/v1/agents/limit", amount: String(LIMIT) },
  { path: "/api/v1/agents/limit-plus-1", amount: String(LIMIT + 1) },
  { path: "/api/v1/agents/no-header", amount: "1", mode: "no-header" },
  { path: "/api/v1/agents/wrong-asset", amount: "1", mode: "wrong-asset" },
  { path: "/api/v1/agents/wrong-network", amount: "1", mode: "wrong-network" },
  { path: "/api/v1/agents/always-402", amount: "1", mode: "always-402" },
  { path: "/api/v1/agents/redirect", amount: "1", mode: "redirect" },
];

let hub: MockHub;
const logs: string[] = [];

function configFor(env: Record<string, string> = {}) {
  return loadConfig({ AGENTS_BASE_URL: hub.baseUrl, AGENT_PRIVATE_KEY: wallet.privateKey, MAX_USDC_PER_CALL: CAP, ...env });
}

async function call(name: string, env: Record<string, string> = {}) {
  const cfg = configFor(env);
  const agents = await fetchCatalog(cfg.baseUrl, 5000, (m) => logs.push(m));
  const agent = agents.find((a) => a.id === name);
  assert.ok(agent, `catalog is missing ${name}`);
  const out = await new HubClient(cfg).callAgent(agent, { q: "hi" });
  return { out, path: new URL(agent.url).pathname };
}

before(async () => {
  hub = await startMockHub(routes);
});
after(() => hub.close());

describe("catalog", () => {
  it("drops entries whose path leaves the hub origin and keeps the rest", async () => {
    const agents = await fetchCatalog(hub.baseUrl, 5000, (m) => logs.push(m));
    assert.equal(agents.length, routes.length);
    assert.ok(agents.every((a) => new URL(a.url).origin === hub.baseUrl));
    assert.ok(logs.some((m) => m.includes("evil")));
  });

  it("rejects malformed entries", () => {
    const base = "https://hub.example";
    for (const bad of [
      { id: "a b", path: "/x", priceUsdc: "1" },
      { id: "a", path: "https://evil.example/x", priceUsdc: "1" },
      { id: "a", path: "/\\evil.example", priceUsdc: "1" },
      { id: "a", path: "/x", priceUsdc: "0x10" },
      { id: "a", path: "/x", priceUsdc: 1 },
      null,
    ]) {
      assert.equal(typeof parseAgent(bad, base), "string", JSON.stringify(bad));
    }
  });
});

describe("exact payment", () => {
  it("signs a valid EIP-3009 authorization and retries once", async () => {
    const { out, path } = await call("pay");
    assert.equal(out.isError, false);
    assert.deepEqual(JSON.parse(out.text)._provenance, { id: "p1" });
    assert.equal(out.payment?.amountUsdc, "0.25");

    const posts = hub.posts(path);
    assert.equal(posts.length, 2);
    assert.equal(posts[0]!.headers["payment-signature"], undefined);
    const payload = JSON.parse(Buffer.from(posts[1]!.headers["payment-signature"] as string, "base64").toString());
    assert.equal(payload.x402Version, 2);
    assert.deepEqual(payload.accepted, requirementFor("250000"));
    assert.equal(payload.resource.url, `${hub.baseUrl}${path}`);

    const { signature, authorization: a } = payload.payload;
    assert.equal(a.from, wallet.address);
    assert.equal(a.to, PAY_TO);
    assert.equal(a.value, "250000");
    assert.match(a.nonce, /^0x[0-9a-f]{64}$/);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Number(a.validBefore) > now && Number(a.validBefore) <= now + 60 + 5);
    const recovered = verifyTypedData(
      { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE },
      TYPES,
      { from: a.from, to: a.to, value: a.value, validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce },
      signature,
    );
    assert.equal(recovered, wallet.address);
  });

  it("enforces MAX_USDC_PER_CALL at limit-1, limit and limit+1", async () => {
    const results = {
      minus: await call("limit-minus-1"),
      at: await call("limit"),
      plus: await call("limit-plus-1"),
    };
    assert.equal(results.minus.out.isError, false);
    assert.equal(results.at.out.isError, false);
    assert.equal(results.plus.out.isError, true);
    assert.match(results.plus.out.text, /1\.000001 USDC exceeds MAX_USDC_PER_CALL of 1\.00/);
    assert.equal(hub.posts(results.minus.path).length, 2);
    assert.equal(hub.posts(results.at.path).length, 2);
    const refused = hub.posts(results.plus.path);
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.headers["payment-signature"], undefined);
  });

  it("returns payment instructions without a key and sends nothing signed", async () => {
    const cfg = loadConfig({ AGENTS_BASE_URL: hub.baseUrl });
    const agent = (await fetchCatalog(cfg.baseUrl, 5000, () => {})).find((a) => a.id === "pay")!;
    const before = hub.posts("/api/v1/agents/pay").length;
    const out = await new HubClient(cfg).callAgent(agent, { q: "hi" });
    assert.equal(out.isError, true);
    assert.match(out.text, /Price: 0\.25 USDC/);
    assert.ok(out.text.includes(PAY_TO) && out.text.includes("AGENT_PRIVATE_KEY"));
    assert.equal(hub.posts("/api/v1/agents/pay").length, before + 1);
  });

  for (const name of ["no-header", "wrong-asset", "wrong-network"]) {
    it(`never pays an unsupported challenge (${name})`, async () => {
      const { out, path } = await call(name);
      assert.equal(out.isError, true);
      assert.match(out.text, /Nothing was paid/);
      assert.equal(hub.posts(path).length, 1);
    });
  }

  it("does not retry more than once when the hub keeps answering 402", async () => {
    const { out, path } = await call("always-402");
    assert.equal(out.isError, true);
    assert.match(out.text, /not accepted/);
    assert.equal(hub.posts(path).length, 2);
  });

  it("does not follow redirects", async () => {
    const before = hub.posts("/api/v1/agents/pay").length;
    const { out } = await call("redirect");
    assert.equal(out.isError, true);
    assert.equal(hub.posts("/api/v1/agents/pay").length, before);
  });
});

describe("API key", () => {
  it("sends X-API-KEY and never signs", async () => {
    const { out, path } = await call("pay", { AGENTS_API_KEY: "good-key", AGENT_PRIVATE_KEY: "" });
    assert.equal(out.isError, false);
    const last = hub.posts(path).at(-1)!;
    assert.equal(last.headers["x-api-key"], "good-key");
    assert.equal(last.headers["payment-signature"], undefined);
  });
});

describe("config", () => {
  it("accepts https and loopback http only", () => {
    assert.equal(parseBaseUrl("https://agents.writerslogic.com/"), "https://agents.writerslogic.com");
    assert.equal(parseBaseUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
    for (const bad of ["http://agents.example.com", "ftp://x", "not a url", "https://u:p@x.example", "https://x.example/?a=1"]) {
      assert.throws(() => parseBaseUrl(bad), ConfigError, bad);
    }
  });

  it("parses USDC amounts exactly and rejects junk", () => {
    assert.equal(parseUsdc("1.00", "X"), 1_000_000n);
    assert.equal(parseUsdc("0.000001", "X"), 1n);
    for (const bad of ["", "1e3", "-1", "1.0000001", "0x1", "1,5"]) assert.throws(() => parseUsdc(bad, "X"), ConfigError, bad);
  });

  it("rejects a bad private key without echoing it", () => {
    const secret = "not-a-key-but-secret";
    try {
      loadConfig({ AGENT_PRIVATE_KEY: secret });
      assert.fail("should throw");
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      assert.ok(!e.message.includes(secret));
    }
  });
});

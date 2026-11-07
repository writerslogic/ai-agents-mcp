import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Wallet } from "ethers";
import { loadConfig, ConfigError } from "../src/config.js";
import { createServer } from "../src/server.js";
import { BATCH_PATH, startMockHub, type HubOptions, type MockHub, type Route } from "./mockHub.js";

const wallet = Wallet.createRandom();
const routes: Route[] = [
  { path: "/api/v1/agents/big-agent", amount: "500000" },
  { path: "/api/v1/micro/checksum", amount: "5000", package: "ids-kit" },
  { path: "/api/v1/micro/vin-decode", amount: "5000", package: "ids-kit" },
  { path: "/api/v1/micro/allocate", amount: "5000", package: "money-kit" },
  { path: BATCH_PATH, amount: "20000" },
];

type Result = { isError?: boolean; content: { type: string; text: string }[] };
const clients: Client[] = [];
after(() => Promise.all(clients.map((c) => c.close())));

async function serverFor(hub: MockHub, env: Record<string, string> = {}) {
  const cfg = loadConfig({ AGENTS_BASE_URL: hub.baseUrl, AGENT_PRIVATE_KEY: wallet.privateKey, AGENTS_PROFILE: "all", ...env });
  const logs: string[] = [];
  const { server } = createServer(cfg, (m) => logs.push(m), "0.0.0");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  clients.push(client);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  const call = async (name: string, args?: Record<string, unknown>) =>
    (await client.callTool({ name, ...(args && { arguments: args }) })) as Result;
  return { tools, call, logs, names: tools.map((t) => t.name).sort() };
}

async function withHub(opts: HubOptions, fn: (hub: MockHub) => Promise<void>) {
  const hub = await startMockHub(routes, opts);
  try {
    await fn(hub);
  } finally {
    await hub.close();
  }
}

let hub: MockHub;
before(async () => {
  hub = await startMockHub(routes);
});
after(() => hub.close());

describe("package tools", () => {
  it("fetch the light catalog and list one tool per package next to standalone agents", async () => {
    const { names, tools } = await serverFor(hub);
    assert.deepEqual(names, ["big_agent", "ids_kit", "micro_batch", "money_kit", "verify_provenance"]);
    assert.ok(hub.requests.some((r) => r.path === "/api/v1/catalog" && r.url.endsWith("?view=tools")));
    const ids = tools.find((t) => t.name === "ids_kit")!;
    assert.deepEqual((ids.inputSchema.properties as Record<string, { enum?: string[] }>).check!.enum, ["checksum", "vin-decode"]);
    assert.match(ids.description ?? "", /checksum \(0\.005000\): Summary of checksum\./);
    assert.match(ids.description ?? "", /up to 20 checks .* 0\.020000 USDC payment/);
  });

  it("run one check at its own path, paying its own price", async () => {
    const { call } = await serverFor(hub);
    const before = hub.posts("/api/v1/micro/checksum").length;
    const out = await call("ids_kit", { check: "checksum", input: { q: "4111" } });
    assert.notEqual(out.isError, true);
    assert.deepEqual(JSON.parse(out.content[0]!.text).data.echoed, { q: "4111" });
    const posts = hub.posts("/api/v1/micro/checksum").slice(before);
    assert.equal(posts.length, 2);
    const payment = JSON.parse(Buffer.from(posts[1]!.headers["payment-signature"] as string, "base64").toString());
    assert.equal(payment.accepted.amount, "5000");
  });

  it("send calls to the batch endpoint as {calls: [{tool, input}]}", async () => {
    const { call } = await serverFor(hub);
    const calls = [
      { check: "checksum", input: { q: "a" } },
      { check: "vin-decode", input: { q: "b" } },
    ];
    const out = await call("ids_kit", { calls });
    assert.notEqual(out.isError, true);
    assert.deepEqual(JSON.parse(out.content[0]!.text).data.echoed, {
      calls: [
        { tool: "checksum", input: { q: "a" } },
        { tool: "vin-decode", input: { q: "b" } },
      ],
    });
  });

  it("describe a check for free from the package detail view", async () => {
    const { call } = await serverFor(hub);
    const postsBefore = hub.requests.filter((r) => r.method === "POST").length;
    const out = await call("ids_kit", { describe: true, check: "vin-decode" });
    assert.notEqual(out.isError, true);
    const body = JSON.parse(out.content[0]!.text);
    assert.equal(body.check, "vin-decode");
    assert.deepEqual(body.inputSchema.required, ["q"]);
    assert.deepEqual(body.example, { q: "example for vin-decode" });
    const listing = JSON.parse((await call("ids_kit", { describe: true })).content[0]!.text);
    assert.deepEqual(listing.checks.map((c: { id: string }) => c.id), ["checksum", "vin-decode"]);
    assert.equal(hub.requests.filter((r) => r.method === "POST").length, postsBefore);
    const gets = hub.requests.filter((r) => r.path.startsWith("/api/v1/packages/"));
    assert.ok(gets.every((r) => r.headers["payment-signature"] === undefined && r.headers["x-api-key"] === undefined));
  });

  it("reject malformed arguments locally without contacting the hub", async () => {
    const { call } = await serverFor(hub, { AGENTS_API_KEY: "good-key" });
    const before = hub.requests.length;
    const bad: Record<string, unknown>[] = [
      { check: "allocate", input: {} }, // another package's check
      { check: "checksum" }, // no input
      { check: "checksum", input: [] },
      { tool: "checksum", input: {} },
      { describe: "yes" },
      { calls: [] },
      { calls: Array.from({ length: 21 }, () => ({ check: "checksum", input: {} })) },
      { calls: [{ check: "checksum", input: {} }], check: "checksum", input: {} },
      { calls: [{ check: "allocate", input: {} }] },
      { calls: [{ check: "checksum", input: {}, extra: 1 }] },
      {},
    ];
    for (const args of bad) {
      const out = await call("ids_kit", args);
      assert.equal(out.isError, true, JSON.stringify(args));
    }
    assert.equal(hub.requests.length, before);
    const max = await call("ids_kit", { calls: Array.from({ length: 20 }, () => ({ check: "checksum", input: {} })) });
    assert.notEqual(max.isError, true);
  });

  it("AGENTS_PACKAGES expands the named packages into individual tools", async () => {
    assert.deepEqual((await serverFor(hub, { AGENTS_PACKAGES: "ids-kit" })).names, [
      "big_agent",
      "checksum",
      "micro_batch",
      "money_kit",
      "verify_provenance",
      "vin_decode",
    ]);
    assert.deepEqual((await serverFor(hub, { AGENTS_PACKAGES: "all" })).names, [
      "allocate",
      "big_agent",
      "checksum",
      "micro_batch",
      "verify_provenance",
      "vin_decode",
    ]);
    const { logs } = await serverFor(hub, { AGENTS_PACKAGES: "no-such-kit" });
    assert.ok(logs.some((m) => m.includes('no package "no-such-kit"')));
    assert.throws(() => loadConfig({ AGENTS_PACKAGES: "ids kit" }), ConfigError);
  });

  it("fall back to one tool per agent on a hub without packages", async () => {
    await withHub({ packages: false }, async (old) => {
      const { names, call } = await serverFor(old);
      assert.deepEqual(names, ["allocate", "big_agent", "checksum", "micro_batch", "verify_provenance", "vin_decode"]);
      const out = await call("checksum", { q: "x" });
      assert.notEqual(out.isError, true);
    });
  });

  it("ignore unusable package indexes and off-origin batch paths", async () => {
    await withHub({ packageIndex: { packages: "nope" } }, async (h) => {
      const { names, logs } = await serverFor(h);
      assert.ok(names.includes("checksum") && !names.includes("ids_kit"));
      assert.ok(logs.some((m) => m.includes("no packages array")));
    });
    // The batch agent is resolved by id from the validated catalog, never from a path in the index.
    const index = { packages: [{ id: "ids-kit", title: "Ids", tools: [] }], batch: { id: "evil", path: "//attacker.example/x" } };
    await withHub({ packageIndex: index }, async (h) => {
      const { call } = await serverFor(h);
      const out = await call("ids_kit", { calls: [{ check: "checksum", input: {} }] });
      assert.equal(out.isError, true);
      assert.match(out.content[0]!.text, /no batch endpoint/);
      assert.ok(!h.requests.some((r) => r.url.includes("attacker")));
    });
  });
});

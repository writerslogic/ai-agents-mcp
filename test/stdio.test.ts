import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Wallet } from "ethers";
import { startMockHub, type MockHub } from "./mockHub.js";

const entry = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
let hub: MockHub;

before(async () => {
  hub = await startMockHub([
    { path: "/api/v1/agents/lead-enrichment", amount: "500000" },
    { path: "/api/v1/agents/pricey", amount: "2000000" },
  ]);
});
after(() => hub.close());

function connect(baseUrl: string, env: Record<string, string> = {}) {
  const client = new Client({ name: "smoke", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { PATH: process.env.PATH ?? "", AGENTS_BASE_URL: baseUrl, ...env },
    stderr: "pipe",
  });
  return { client, transport, ready: client.connect(transport) };
}

describe("stdio server (dist/index.js)", () => {
  it("initializes, lists one tool per agent plus verify_provenance, and pays a call", async () => {
    const wallet = Wallet.createRandom();
    const { client, ready } = connect(hub.baseUrl, { AGENT_PRIVATE_KEY: wallet.privateKey });
    try {
      await ready;
      assert.equal(client.getServerVersion()?.name, "writerslogic-ai-agents-mcp");

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      assert.deepEqual(names, ["lead_enrichment", "pricey", "verify_provenance"]);
      const lead = tools.find((t) => t.name === "lead_enrichment")!;
      assert.match(lead.description ?? "", /0\.500000 USDC/);
      assert.deepEqual(lead.inputSchema.required, ["q"]);

      const paid = await client.callTool({ name: "lead_enrichment", arguments: { q: "acme" } });
      assert.notEqual(paid.isError, true);
      const text = (paid.content as { type: string; text: string }[])[0]!.text;
      assert.deepEqual(JSON.parse(text).data.echoed, { q: "acme" });

      const refused = await client.callTool({ name: "pricey", arguments: { q: "x" } });
      assert.equal(refused.isError, true);
      assert.match((refused.content as { text: string }[])[0]!.text, /2\.00 USDC exceeds MAX_USDC_PER_CALL of 1\.00/);

      const prov = await client.callTool({ name: "verify_provenance", arguments: { data: {}, _provenance: {} } });
      assert.equal(prov.isError, false);
      assert.equal(hub.requests.filter((r) => r.path === "/api/v1/verify-provenance").length, 1);
    } finally {
      await client.close();
    }
  });

  it("still serves verify_provenance when the hub is unreachable", async () => {
    const { client, ready } = connect("http://127.0.0.1:1");
    try {
      await ready;
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ["verify_provenance"]);
    } finally {
      await client.close();
    }
  });

  it("exits non-zero on invalid configuration", async () => {
    const { client, ready } = connect(hub.baseUrl, { MAX_USDC_PER_CALL: "lots" });
    await assert.rejects(ready);
    await client.close().catch(() => {});
  });
});

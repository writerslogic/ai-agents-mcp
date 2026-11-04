#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { createServer } from "./server.js";

// stdout carries the MCP stream; everything human-readable goes to stderr.
const log = (msg: string) => process.stderr.write(`[writerslogic-ai-agents-mcp] ${msg}\n`);

function packageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main() {
  const cfg = loadConfig();
  const { server, registry } = createServer(cfg, log, packageVersion());
  log(
    cfg.wallet
      ? `paying from ${cfg.wallet.address}, cap ${cfg.maxPerCallUsdc} USDC per call`
      : cfg.apiKey
        ? "using AGENTS_API_KEY; no wallet configured"
        : "no AGENT_PRIVATE_KEY or AGENTS_API_KEY: paid calls will return payment instructions",
  );
  void registry.refresh();
  await server.connect(new StdioServerTransport());
  const stop = () => process.exit(0);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  log(`fatal: ${err instanceof ConfigError ? err.message : err instanceof Error ? err.message : "unknown error"}`);
  process.exit(1);
});

# @writerslogic/ai-agents-mcp

An MCP server that exposes the [WritersLogic x402 agent hub](https://agents.writerslogic.com) as tools. Each hub agent becomes one tool. Calls are priced in USDC and paid over [x402](https://github.com/coinbase/x402) on Base, with no gas needed from the buyer.

The server is a thin client: it fetches the hub catalog, registers a tool per agent, forwards calls over HTTPS, and signs a payment authorization when the hub asks for one and your spending cap allows it.

## Install

Requires Node.js 20 or later. No global install is needed; MCP clients run it with `npx`, which builds it from this repository on first run.

```json
{
  "mcpServers": {
    "writerslogic-ai-agents": {
      "command": "npx",
      "args": ["-y", "github:writerslogic/ai-agents-mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x...",
        "MAX_USDC_PER_CALL": "1.00"
      }
    }
  }
}
```

Put that block in your client's MCP configuration:

| Client | Config file |
| --- | --- |
| Claude Desktop | `claude_desktop_config.json` (Settings, Developer, Edit Config) |
| Cursor | `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Cline | `cline_mcp_settings.json` (MCP Servers, Configure MCP Servers) |
| Claude Code | `claude mcp add writerslogic-ai-agents -e AGENT_PRIVATE_KEY=0x... -- npx -y github:writerslogic/ai-agents-mcp` |

Omit `AGENT_PRIVATE_KEY` to browse and to see prices: paid tools then return the payment instructions instead of paying.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_PRIVATE_KEY` | unset | Private key of the wallet that pays. Needs USDC on Base, no ETH. Use a dedicated low-balance wallet. |
| `MAX_USDC_PER_CALL` | `1.00` | Per-call spending cap. A call whose price is above it is refused before anything is signed. |
| `AGENTS_API_KEY` | unset | Sent as `X-API-KEY`. Bypasses payment. |
| `AGENTS_BASE_URL` | `https://agents.writerslogic.com` | Hub URL. Must be `https`; plain `http` is accepted for `localhost` only. |
| `AGENTS_TIMEOUT_MS` | `120000` | Timeout for tool calls (1000 to 600000). The catalog fetch uses at most 15 s. |

## Tools

Tools are discovered from the hub catalog (`GET /api/v1/catalog`) when the server starts and refreshed on `tools/list` after ten minutes, so the live list is authoritative. Tool names are the agent id with every character outside `A-Za-z0-9_` replaced by `_`. Each tool takes the agent's own input schema. Agents at the time of writing:

| Tool | Price (USDC) | Description |
| --- | ---: | --- |
| `abandoned_compound_miner` | 2.00 | Abandoned Compound & Uncommercialized Trial Miner |
| `accessibility_patcher` | 0.75 | ADA / WCAG Lawsuit Shield & DOM Auto-Patcher |
| `arxiv_to_code` | 1.00 | arXiv-to-Production Code & Hyperparameter Compiler |
| `token_trap_detector` | 0.25 | On-Chain Bytecode & Unverified Token Trap Detector |
| `chargeback_fighter` | 2.50 | E-Commerce Chargeback Representment Builder |
| `clarification_impact` | 0.50 | Prediction-Market Clarification Impact Pricer |
| `competitor_battlecard` | 1.50 | SaaS Pricing & Competitor Battlecard Spy |
| `contract_auditor` | 1.00 | Smart Contract Auditor |
| `contract_terminator` | 1.00 | Dark Pattern Contract & Subscription Exit Lawyer |
| `cover_claim` | 5.00 | DeFi Cover Claim Adjudicator |
| `diff_gatekeeper` | 0.50 | PR / Dependency Breaking-Change & Exploit Gatekeeper |
| `dispute_ev` | 0.50 | UMA Dispute EV Desk |
| `foreignResearchScout` | 1.50 | Cross-Lingual Dark Science Arbitrage Scout |
| `lead_enrichment` | 0.50 | Autonomous Lead Enrichment |
| `market_predictor` | 0.10 | Prediction Market Analyzer |
| `medical_bill_auditor` | 3.00 | Medical Bill Upcoding & Overcharge Slasher |
| `milestone_verifier` | 2.00 | Grant Milestone Verifier with Signed Release Attestation |
| `patent_design_around` | 2.00 | Patent Design-Around & Freedom-to-Operate Architect |
| `prior_art_invalidator` | 2.50 | Global Prior-Art Patent Invalidator |
| `replication_auditor` | 0.75 | Scientific Consensus & Replication Failure Auditor |
| `arbitrage_lawyer` | 0.75 | Cross-Platform Arbitrage & Resolution Rules Lawyer |
| `heal_scraper` | 0.40 | Self-Healing Scraper & DOM-to-JSON Compiler |
| `tariff_engineer` | 1.50 | Global Customs & Tariff Engineering Optimizer |
| `vault_exit_lawyer` | 0.25 | Vault Exit Lawyer |

Also always available, and free:

| Tool | Description |
| --- | --- |
| `verify_provenance` | POSTs to `/api/v1/verify-provenance` to check the `_provenance` record on a paid result. |

A paid result is the hub's JSON response, returned unchanged as text content.

## How payment works

1. The tool POSTs your arguments to the agent endpoint.
2. If the hub answers `402`, it sends a base64 `PAYMENT-REQUIRED` header (x402 v2) listing an `exact` scheme requirement: network `eip155:8453`, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, an atomic `amount` (6 decimals), `payTo`, and the token's EIP-712 name and version.
3. If `AGENT_PRIVATE_KEY` is set and `amount` is at most `MAX_USDC_PER_CALL`, the client signs an EIP-3009 `TransferWithAuthorization` (EIP-712, USDC domain on chain 8453) for exactly that amount to `payTo`, valid for the requirement's timeout, with a random nonce.
4. It retries the same request once with the base64 `PAYMENT-SIGNATURE` header. The hub's facilitator submits the transfer and pays the gas.
5. The result is returned. If the retry is not accepted, the error is returned and nothing further is sent.

If no key is configured, or the price is over the cap, the tool returns an error that states the price, network, asset and `payTo`, and no signature is produced.

## Provenance

Paid results carry a `_provenance` record next to `data`. Pass the whole `{data, _provenance}` object to `verify_provenance` to check it against the hub. The request body is forwarded as given.

## Security

- **The key stays local.** `AGENT_PRIVATE_KEY` is read once from the environment, used only to sign typed data, and never logged or sent anywhere. Authorizations are signatures; the client never broadcasts a transaction.
- **The cap is per call, not per session.** An agent that calls tools in a loop can spend `MAX_USDC_PER_CALL` each time. Fund the wallet with only what you are willing to lose, and lower the cap to the most expensive tool you actually want to allow.
- **Only USDC on Base is signed for.** Challenges naming another network, asset, or transfer method are refused, so a malicious or compromised hub cannot ask for a different token. Base Sepolia (`eip155:84532`) USDC is also accepted for testing.
- **Catalog entries are untrusted.** Endpoints must resolve to the hub's own origin, ids and prices are validated, and redirects are never followed, so credentials and signatures are not sent to other hosts.
- **Bounds.** Requests are limited to 1 MiB, responses to 2 MiB, and every request has a timeout.
- **Stdout is the MCP stream.** Logs go to stderr only; they include the paying address and each payment amount, never the key.
- Anyone who holds a signed authorization before it expires could submit it, up to the signed amount and to `payTo` only.

## Development

```sh
npm install
npm run build
npm test
```

Tests run against a local mock hub and verify the EIP-3009 signature by recovering the signer, the cap at limit-1, limit and limit+1, and an end-to-end stdio session against `dist/index.js`. No network access or funds are involved.

## License

Apache-2.0. Copyright 2026 WritersLogic.

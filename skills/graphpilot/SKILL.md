---
name: graphpilot
description: Query live Subgraph data on The Graph from an agent session — discover endpoints and auth, snapshot DeFi liquidity (pools/TVL), narrate recent swap flow, and explain results as reasoned summaries instead of raw JSON. Use when the task mentions The Graph, subgraphs, TVL/liquidity, swap activity, GraphQL over a subgraph endpoint, or Subgraph Studio keys/auth.
---

# GraphPilot — Subgraph queries for AI agents (CLI + MCP)

Two surfaces over one provider stack (same env, same fail-closed rules):

- **CLI**: `node bin/graphpilot.mjs <command>` (zero dependencies, Node >= 18)
- **MCP**: stdio server `node mcp/server.mjs` — newline-delimited JSON-RPC 2.0

## When to use

- "Top pools / TVL on <protocol>?" → `pools` (CLI) or `run_graphql` + `explain_result` (MCP)
- "Any big recent swaps / flow?" → `swaps` (CLI) or `run_graphql` + `explain_result` (MCP)
- "Which endpoint/auth do I need for The Graph?" → `discover` (CLI) or `search_subgraphs` (MCP)
- You already have a GraphQL query → `run_graphql` (MCP)
- "Execute the value movement that follows from this data" → `keeperhub_transfer` (MCP) or
  `keeperhub-tx` (CLI) — proof = `transactionLink` + verified receipt (testnet ok)

## Workflow — dry-run FIRST, always

1. **Dry-run sanity (no key, no network):**
   `GRAPHPILOT_PROVIDER=dry-run node bin/graphpilot.mjs pools`
   Output is tagged `[DRY-RUN MOCK — TODO-VERIFY live]` — confirms install + query shape offline.
2. **Discover endpoints/provider/schema:** `node bin/graphpilot.mjs discover` (prints the 9-endpoint
   DAY0-NOTES matrix, the active provider, and a `__schema` probe).
3. **Real query:** CLI `pools`/`swaps`, or MCP `run_graphql` — requires a live provider (see table).
4. **Explain, don't dump:** MCP `explain_result` for a compact summary; CLI already prints takeaways.

Never present dry-run output as live data — it is always tagged; keep the tag in your answer.

## CLI commands (6)

| Command | What you get |
|---|---|
| `graphpilot discover [--id <subgraphId>]` | endpoint matrix + active provider + GraphQL introspection of root fields |
| `graphpilot pools [--page N] [--limit N]` | TVL snapshot table (pools by totalValueLockedUSD desc) + top-pool takeaway |
| `graphpilot swaps [--page N] [--limit N]` | recent swaps table (by timestamp desc) + largest/median swap takeaway |
| `graphpilot keeperhub-tx simulate --chain-id N --to 0x.. --amount A [--token 0x..]` | KeeperHub simulation verdict (`success`/`wouldRevert`) — nothing broadcast |
| `graphpilot keeperhub-tx transfer <same flags>` | simulate → broadcast (canonical Idempotency-Key) → poll; prints `transactionLink` + `verified` + `receiptStatus` |
| `graphpilot keeperhub-tx status --execution-id <id>` | one KeeperHub execution poll + proof fields |

## MCP tools (5)

Start the server: `node mcp/server.mjs` (speaks `initialize`, `tools/list`, `tools/call`).

Register with a client (`mcp.json`):

```json
{
  "mcpServers": {
    "graphpilot": { "command": "node", "args": ["/absolute/path/to/repo/mcp/server.mjs"] }
  }
}
```

TODO-VERIFY: this install snippet and the protocol round-trip are validated only by
`tests/mcp-smoke.mjs` so far — confirm once against a real MCP client (Cursor / Claude Desktop).

- `search_subgraphs(query)` → matches in the LOCAL registry (1 known subgraph + 9 endpoints from
  DAY0-NOTES). Offline, no key needed. Explorer-wide/live search not implemented yet.
- `run_graphql(endpoint_ref, gql, vars)` → one GraphQL POST through the CLI provider stack.
  `endpoint_ref`: `"configured"` (default) or `"dry-run"`. `vars` optional (sent as `{ variables }`).
- `explain_result(result_json)` → shape + totals + takeaways; tags DRY-RUN payloads.
- `keeperhub_transfer(chain_id, to, amount, token?, simulate?, mode?)` → value-rail: route a
  transfer through the KeeperHub execution layer. `simulate=true` (default) never broadcasts and
  never returns a tx hash; `simulate=false` broadcasts (canonical Idempotency-Key), polls to a
  terminal state and returns `transactionLink` + `verified` + `receiptStatus` — the onchain proof.
  Needs `KEEPERHUB_KEY` (org `kh_` key; `mcp:write` for broadcast), fail closed without it;
  `KEEPERHUB_PROVIDER=dry-run` or `mode:"dry-run"` = labeled offline mock. Testnet chains are the
  demo path (11155111 Sepolia / 84532 Base Sepolia). The whole live path is TODO-VERIFY until the
  org key + testnet funds exist.
- `keeperhub_tx_status(execution_id, mode?)` → poll one execution: status, poll-interval hint,
  proof fields. `unconfirmed` is NOT a failure and must never be rebroadcast.

## Providers (first match wins — identical for CLI and MCP)

| Priority | Input | Path |
|---|---|---|
| 1 | `--provider dry-run` / `GRAPHPILOT_PROVIDER=dry-run` | labeled mock fixtures (offline/CI only) |
| 2 | `GRAPHPILOT_DEPLOYMENT_ID` + `GRAPH_STUDIO_KEY` | gateway deployment, endpoint #3 (Bearer) |
| 3 | `GRAPHPILOT_ENDPOINT` | Studio deploy URL, endpoint #6 (keyless — your own deployments only) |
| 4 | `GRAPH_STUDIO_KEY` | gateway Bearer, endpoint #2 — primary live path |
| — | nothing | typed `missing_api_key`, fail closed (CLI exit 2 / MCP `isError: true`) |

Secrets are **env-only**: never in `config.json` (refused with `secret_in_config`), never inside
`mcp.json`. Get a free key at thegraph.com/studio.

## Failure modes (typed)

- Query/network (CLI exit 1, MCP `isError`): `http_401/402/403/404/429`, `graphql_errors`,
  `timeout`, `network`, `bad_json`, `bad_response`, `mock_unmatched` (dry-run only knows the
  3 ship queries + `__schema` introspection); KeeperHub adds `wallet_not_configured` (422),
  `http_400` (simulate diagnostics), `simulate_reverted`, `bad_input`.
- Config/usage (CLI exit 2): `missing_api_key` (Graph providers and KeeperHub — export
  `GRAPH_STUDIO_KEY` / `KEEPERHUB_KEY`), `config_not_found`, `config_invalid`, `secret_in_config`.
- `http_401` → check `GRAPH_STUDIO_KEY`; `http_429` → back off (Studio URLs are rate-limited);
  `graphql_errors` → re-check field names via `discover`; KeeperHub 429 → back off and do NOT
  rebroadcast with a fresh Idempotency-Key.

## Rules for agents

1. Dry-run is step 1, always.
2. Keep the `[DRY-RUN MOCK]` tag wherever dry-run numbers are cited.
3. Prefer `explain_result` / CLI takeaway lines over raw JSON in user-facing answers.
4. Secrets env-only, never in files.
5. Offline CI must stay offline: `npm test` runs all three suites (`tests/smoke.mjs` +
   `tests/mcp-smoke.mjs` + `tests/keeperhub-smoke.mjs`).
6. KeeperHub: simulate before broadcast; an `unconfirmed` execution is only re-polled, never
   rebroadcast; cite the `transactionLink` proof only when `verified=true` and
   `receiptStatus="success"`.

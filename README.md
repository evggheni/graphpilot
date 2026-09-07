# GraphPilot — CLI core

Live-Subgraph command-line core for the GraphPilot AI-agent tooling (The Graph track,
ETHOnline 2026). Discovers Subgraph endpoints, snapshots DeFi liquidity, and narrates
recent swap flow — reasoned ASCII reports, not raw JSON dumps.

Node >= 18 · ESM · **zero runtime dependencies** (built-in `fetch`).

## Quickstart

```bash
git clone <this repo> graphpilot && cd graphpilot          # nothing to install (zero deps)
node bin/graphpilot.mjs discover                          # endpoint matrix + provider + schema probe
node bin/graphpilot.mjs pools --provider dry-run          # TVL snapshot on labeled mock fixtures (offline/CI)
GRAPH_STUDIO_KEY=<key> node bin/graphpilot.mjs pools      # LIVE: gateway endpoint #2 (Bearer auth)
npm test                                                  # offline smoke suites: CLI core + MCP server (mock fixtures only)
```

## Commands

| Command | Ship query (DAY0-NOTES) | Output |
|---|---|---|
| `discover [--id <subgraphId>]` | #1 discovery + schema proof | 9-endpoint auth matrix, active provider, GraphQL introspection of root fields |
| `pools [--page N] [--limit N]` | #2 DeFi liquidity snapshot (`pools` by TVL desc) | ASCII table + `% of TVL shown` takeaway |
| `swaps [--page N] [--limit N]` | #3 recent flow (`swaps` by timestamp desc) | ASCII table + largest/median swap takeaway |
| `keeperhub-tx simulate --chain-id N --to 0x.. --amount A [--token 0x..]` | KeeperHub Direct Execution | simulation verdict (`success`/`wouldRevert`), nothing broadcast |
| `keeperhub-tx transfer <same flags>` | KeeperHub Direct Execution | simulate → broadcast (Idempotency-Key) → poll; prints `transactionLink` + `verified` + `receiptStatus` |
| `keeperhub-tx status --execution-id <id>` | KeeperHub Direct Execution | one status poll + proof fields |

Paging maps `--page/--limit` to GraphQL `skip/first` (default `limit: 5`, as in DAY0-NOTES).

## MCP server (`mcp/server.mjs`)

Zero-dependency Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0):
`initialize`, `tools/list`, `tools/call`, `ping`. Same provider stack and fail-closed rules as the
CLI; DRY-RUN results stay tagged. Tools:

| Tool | Purpose |
|---|---|
| `search_subgraphs(query)` | local registry search: known subgraph ids + the 9-endpoint DAY0-NOTES matrix (offline, no key needed) |
| `run_graphql(endpoint_ref, gql, vars)` | one GraphQL POST via the CLI providers; `endpoint_ref`: `"configured"` or `"dry-run"`; typed errors become `isError` results |
| `explain_result(result_json)` | reasoned summary (shape, totals, takeaways) — never a raw JSON dump; tags DRY-RUN payloads |
| `keeperhub_transfer(chain_id, to, amount, token?, simulate?, mode?)` | route a transfer through the KeeperHub execution layer; `simulate=true` (default) never broadcasts; `simulate=false` = broadcast + poll, returns `transactionLink` + `verified` + `receiptStatus` |
| `keeperhub_tx_status(execution_id, mode?)` | poll one execution: status, poll-interval hint, proof fields; `unconfirmed` is not a failure and is never rebroadcast |

Register in a client (`mcp.json`): `{"mcpServers":{"graphpilot":{"command":"node","args":["/abs/path/repo/mcp/server.mjs"]}}}` —
the agent-facing workflow lives in `skills/graphpilot/SKILL.md`.

TODO-VERIFY: protocol shape validated by `tests/mcp-smoke.mjs` only — needs one round-trip with a
real MCP client (Cursor / Claude Desktop).

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  AI coding agent (Cursor / Claude)                           │
│   ├─ skills/graphpilot/SKILL.md  (agent workflow)            │
│   └─ mcp/server.mjs  (MCP stdio: search/run/explain)         │
└────────────────────────────┬─────────────────────────────────┘
                             │ spawns / reuses
┌────────────────────────────▼─────────────────────────────────┐
│  graphpilot CLI (this repo)                                  │
│  bin/graphpilot.mjs ── discover / pools / swaps               │
│                       keeperhub-tx simulate/transfer/status   │
│  mcp/server.mjs ── MCP stdio server (same providers)          │
│  src/config.mjs   provider selection (fail closed)            │
│  src/client.mjs   GraphQL POST + typed errors + dry-run mock  │
│  src/keeperhub.mjs KeeperHub execution client (value-rail)    │
│  src/queries.mjs  3 ship queries (DAY0-NOTES verbatim)        │
│  src/format.mjs   ASCII tables + reasoned takeaways           │
└────────────────────────────┬─────────────────────────────────┘
                             │ HTTPS (POST { query })
┌────────────────────────────▼─────────────────────────────────┐
│  The Graph (live only — mock output always labeled DRY-RUN)   │
│  #2 gateway Bearer  · #3 pinned deployment  · #6 Studio URL   │
│  (#1/#4/#5/#7/#8/#9 in registry, see src/endpoints.mjs)       │
└──────────────────────────────────────────────────────────────┘
```

## Providers (first match wins)

| Priority | Input | Endpoint (DAY0-NOTES) | Auth |
|---|---|---|---|
| 1 | `--provider dry-run` | — | labeled mock fixtures, offline/CI only |
| 2 | `GRAPHPILOT_DEPLOYMENT_ID` + key | #3 `POST /api/deployments/id/<ID>` | `Bearer` Studio key (pin for the demo video) |
| 3 | `GRAPHPILOT_ENDPOINT` | #6 Studio deploy URL | keyless — **your own Studio deployments only**, rate-limited |
| 4 | `GRAPH_STUDIO_KEY` | #2 `POST /api/subgraphs/id/<ID>` | `Bearer` — primary live path |
| — | nothing | — | typed `missing_api_key` error, exit 2 (fail closed, never silent mocks) |

Secrets are **env-only by design** (`config.json` refuses an `apiKey` field). Copy
`config.example.json` → `config.json` for endpoint/id/page-size defaults.

Typed errors (exit 1): `http_401/402/403/404/429`, `graphql_errors`, `timeout`,
`network`, `bad_json`, `bad_response`. Config/usage errors (exit 2):
`missing_api_key`, `config_not_found`, `config_invalid`, `secret_in_config`.

## KeeperHub integration (value-rail)

GraphPilot reads indexed data on The Graph (data-rail); [KeeperHub](https://docs.keeperhub.com) is
the execution layer for the value movement that follows — the DoraHacks "The Agent Economy"
submission requires a real onchain tx through it, proof = `transactionLink`. Implemented per
`../keeperhub-submission/INTEGRATION-SPEC.md` (docs.keeperhub.com: Direct Execution API +
"first verified transaction" guide):

- `src/keeperhub.mjs` — thin Direct Execution REST client: `POST /api/execute/transfer`
  (simulate with strictly-boolean `simulate`, broadcast with canonical `Idempotency-Key` =
  SHA-256 over `taskId|chainId|recipientAddress|amount|tokenAddress`) and
  `GET /api/execute/{id}/status` (respects `X-Poll-Interval-Hint`). Typed errors:
  `http_401/403/429`, `wallet_not_configured` (422), `http_400` (simulate diagnostics),
  `timeout`/`network`. Fail closed without a key, dry-run always tagged
  `[DRY-RUN MOCK — TODO-VERIFY live]` (mock links use `.invalid`, never a real explorer URL).
- Proof rules from the official guide: terminal `status:"completed"` + a `receipts[]` entry with
  `verified:true` **and** `receiptStatus:"success"` → `transactionLink` is the tx-proof.
  Testnet accepted (e.g. Sepolia `11155111`, Base Sepolia `84532` — pick via `GET /api/chains`,
  `isEnabled && isTestnet`). `unconfirmed`/pending is **not** a failure and is never rebroadcast
  (same params → same Idempotency-Key). Default caps: 0.02 ETH/day (EVM), ≤100 USD stablecoin/tx;
  direct execution rate limit 60 req/min per key.
- Integration scenario (submission narrative): an agent reads pool data (`run_graphql` /
  `explain_result`), decides on a treasury top-up, and GraphPilot routes that transfer through
  KeeperHub (`keeperhub_transfer` MCP tool or `keeperhub-tx transfer` CLI) — the returned
  `transactionLink` is recorded in the report/audit.

Env (secrets env-only, same rule as the Graph providers):

| Var | Meaning |
|---|---|
| `KEEPERHUB_KEY` | org API key `kh_…` (app.keeperhub.com → Settings → Developer → API keys; scope `mcp:write` to broadcast, `mcp:read` = simulate only) |
| `KEEPERHUB_API` | API base URL; default `https://api.keeperhub.com` — TODO-VERIFY |
| `KEEPERHUB_PROVIDER=dry-run` | labeled offline mock (or `--provider dry-run` on the CLI / `mode:"dry-run"` on the MCP tools) |

No live tx has been executed yet — the whole keeperhub path is TODO-VERIFY until the org key +
testnet funds exist (owner step). Dry-run, fail-closed and error/poll semantics are covered by
`tests/keeperhub-smoke.mjs`.

## TODO-VERIFY (until first live run)

- [ ] Endpoint #2 response/error shape vs live gateway (implemented from docs; needs Studio API key — owner action, Sep 7 per TECH-PLAN)
- [ ] Endpoint #6 keyless path never exercised (requires an own Studio deployment URL)
- [ ] `_meta` root field on the target subgraph (listed in dry-run fixture only)
- [ ] x402 (#4/#5), MCP SSE (#7), Token API (#8/#9): registry entries only, not implemented
- [ ] MCP server protocol round-trip with a real MCP client (Cursor / Claude Desktop) — so far validated only by tests/mcp-smoke.mjs; run_graphql `vars` never exercised live
- [ ] KeeperHub: the whole live path needs the org key (`kh_`, scope `mcp:write`) + testnet funds — owner step; simulate/broadcast/status bodies never exercised against the live API
- [ ] KeeperHub: default API base `https://api.keeperhub.com` not pinned verbatim in the spec — confirm and set `KEEPERHUB_API`
- [ ] KeeperHub: Idempotency-Key canonicalization (case/trim/decimal form) is our interface agreement — verify against the docs' exact rules
- [ ] KeeperHub: `X-Poll-Interval-Hint` assumed to be seconds; terminal-status closed list, transfer response field naming (`recipientAddress`/`tokenAddress`) and token amount decimals unverified

## AI attribution

Core generated by AI coding agent (Kimi/Cursor agent) on 2026-09-06 from
`../DAY0-NOTES.md` + TECH-PLAN; human owns credentials, live demo and review.

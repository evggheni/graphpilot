#!/usr/bin/env node
// GraphPilot CLI — live Subgraph queries for AI-agent workflows.
// Zero runtime dependencies (Node >= 18 global fetch). See ../README.md.

import { loadConfig, resolveProvider, ConfigError } from "../src/config.mjs";
import { runQuery, GraphQueryError } from "../src/client.mjs";
import { poolsQuery, swapsQuery, SCHEMA_PROBE_QUERY, clampQueryArgs } from "../src/queries.mjs";
import { renderPoolsResult, renderSwapsResult, renderDiscoverResult } from "../src/format.mjs";
import { ENDPOINT_MATRIX } from "../src/endpoints.mjs";
import {
  loadKeeperHubConfig,
  resolveKeeperHubMode,
  keeperhubTransfer,
  keeperhubStatus,
  pollKeeperHubExecution,
  renderKeeperhubSimulate,
  renderKeeperhubTransfer,
  renderKeeperhubStatus,
  KeeperHubError,
} from "../src/keeperhub.mjs";

const VERSION = "0.1.0";

const USAGE = `graphpilot ${VERSION} — live Subgraph CLI core (The Graph · ETHOnline 2026)

Usage:
  graphpilot discover [--id <subgraphId>]       endpoint matrix + provider + schema probe
  graphpilot pools   [--page N] [--limit N]      DeFi liquidity snapshot (query 2 of DAY0-NOTES)
  graphpilot swaps   [--page N] [--limit N]     recent swap flow (query 3 of DAY0-NOTES)
  graphpilot keeperhub-tx simulate --chain-id N --to 0x.. --amount A [--token 0x..]
  graphpilot keeperhub-tx transfer <same flags>  simulate -> broadcast -> poll; prints transactionLink
  graphpilot keeperhub-tx status --execution-id <id>   poll one KeeperHub execution
  graphpilot help | --version

Provider selection (first match wins):
  --provider dry-run          labeled mock fixtures (offline/CI — TODO-VERIFY live)
  GRAPHPILOT_ENDPOINT         keyless Studio deploy URL (endpoint #6, own deployments only)
  GRAPHPILOT_DEPLOYMENT_ID    (+ key) pinned gateway deployment (endpoint #3)
  GRAPH_STUDIO_KEY            gateway Bearer (endpoint #2) — primary live path

KeeperHub execution layer (value-rail, env-only secrets):
  KEEPERHUB_KEY               org API key kh_… (scope mcp:write to broadcast, mcp:read = simulate)
  KEEPERHUB_API               Direct Execution API base (default https://api.keeperhub.com — TODO-VERIFY)
  --provider dry-run          labeled offline mock ([DRY-RUN MOCK — TODO-VERIFY live])

Env/config: GRAPHPILOT_CONFIG=<path>; default auto-loads ./config.json if present
(see config.example.json — secrets are env-only by design).
Exit codes: 0 ok · 1 query/execution error · 2 config/auth/usage error
`;

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  let command = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version" || a === "-v") { flags.version = true; continue; }
    if (a === "--help" || a === "-h") { flags.help = true; continue; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = (eq === -1 ? a : a.slice(0, eq)).slice(2);
      const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
      flags[key] = val ?? "";
      continue;
    }
    if (command === null) command = a;
    positionals.push(a);
  }
  return { command: command ?? "help", sub: positionals[1] ?? null, flags };
}

async function cmdDiscover(cfg, flags) {
  const subgraphId = flags.id || cfg.subgraphId;
  const provider = resolveProvider(cfg, flags);
  const { data, meta } = await runQuery(provider, SCHEMA_PROBE_QUERY, { timeoutMs: cfg.timeoutMs });
  const fields = (data?.__schema?.queryType?.fields ?? []).map((f) => f.name);
  return renderDiscoverResult({ subgraphId, provider, fields, matrix: ENDPOINT_MATRIX, dryRun: meta.dryRun });
}

async function cmdPools(cfg, flags) {
  const provider = resolveProvider(cfg, flags);
  const { page, limit, first, skip } = clampQueryArgs({ page: flags.page, limit: flags.limit ?? cfg.pageSize });
  const { data, meta } = await runQuery(provider, poolsQuery({ first, skip }), { timeoutMs: cfg.timeoutMs });
  return renderPoolsResult({ data, provider, subgraphId: cfg.subgraphId, page, limit, dryRun: meta.dryRun });
}

async function cmdSwaps(cfg, flags) {
  const provider = resolveProvider(cfg, flags);
  const { page, limit, first, skip } = clampQueryArgs({ page: flags.page, limit: flags.limit ?? cfg.pageSize });
  const { data, meta } = await runQuery(provider, swapsQuery({ first, skip }), { timeoutMs: cfg.timeoutMs });
  return renderSwapsResult({ data, provider, subgraphId: cfg.subgraphId, page, limit, dryRun: meta.dryRun });
}

// keeperhub-tx: value-rail through the KeeperHub execution layer (INTEGRATION-SPEC.md).
// simulate -> broadcast (canonical Idempotency-Key) -> poll (X-Poll-Interval-Hint);
// the printed transactionLink + verified receiptStatus is the tx-proof. Dry-run is always tagged.
function keeperhubParams(flags) {
  const chainId = Number(String(flags["chain-id"] ?? flags.chainId ?? "").trim());
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new KeeperHubError({ code: "bad_input", message: "keeperhub-tx needs --chain-id <positive integer, e.g. 11155111 = Ethereum Sepolia>", hint: "pick a testnet from GET /api/chains (isEnabled && isTestnet) — INTEGRATION-SPEC §1.2" });
  }
  const to = String(flags.to ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new KeeperHubError({ code: "bad_input", message: "keeperhub-tx needs --to <EVM address 0x + 40 hex>", hint: "EVM chains only for now — Solana paths TODO-VERIFY" });
  }
  const amount = String(flags.amount ?? "").trim();
  if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new KeeperHubError({ code: "bad_input", message: "keeperhub-tx needs --amount <positive decimal, ETH human units>", hint: "token base units/decimals TODO-VERIFY; direct execution day cap 0.02 ETH (EVM)" });
  }
  const tokenAddress = String(flags.token ?? "").trim();
  if (tokenAddress && !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    throw new KeeperHubError({ code: "bad_input", message: "--token must be an ERC-20 address (0x + 40 hex)", hint: "omit --token for a native ETH transfer" });
  }
  return { chainId, to, amount, tokenAddress };
}

async function cmdKeeperhubTx(cfg, flags, sub) {
  if (sub !== "simulate" && sub !== "transfer" && sub !== "status") {
    throw new KeeperHubError({ code: "bad_input", message: `unknown keeperhub-tx subcommand: ${sub ?? "(none)"}`, hint: "use simulate | transfer | status" });
  }
  const mode = resolveKeeperHubMode(loadKeeperHubConfig(), { provider: flags.provider });
  if (sub === "status") {
    const executionId = String(flags["execution-id"] ?? flags.executionId ?? "").trim();
    if (!executionId) {
      throw new KeeperHubError({ code: "bad_input", message: "keeperhub-tx status needs --execution-id <id>", hint: "the executionId comes from the broadcast response / transfer output" });
    }
    const res = await keeperhubStatus(mode, executionId, { timeoutMs: cfg.timeoutMs });
    return renderKeeperhubStatus({ executionId, result: res, mode });
  }
  const params = keeperhubParams(flags);
  if (sub === "simulate") {
    const result = await keeperhubTransfer(mode, { ...params, simulate: true }, { timeoutMs: cfg.timeoutMs });
    return renderKeeperhubSimulate({ params, result, mode });
  }
  // transfer: simulate first (guide §1.2.4), then broadcast, then poll to terminal.
  const sim = await keeperhubTransfer(mode, { ...params, simulate: true }, { timeoutMs: cfg.timeoutMs });
  if (sim?.success === false || sim?.wouldRevert === true) {
    throw new KeeperHubError({ code: "simulate_reverted", message: `simulation failed (success=${sim?.success} wouldRevert=${sim?.wouldRevert}) — nothing broadcast`, hint: "fix funds/allowance/caps before broadcasting; do not retry blindly" });
  }
  const sent = await keeperhubTransfer(mode, { ...params, simulate: false }, { timeoutMs: cfg.timeoutMs });
  const executionId = sent?.executionId ?? sent?.id ?? null;
  if (!executionId) {
    throw new KeeperHubError({ code: "bad_response", message: "broadcast accepted but no executionId in the response — TODO-VERIFY live shape", hint: "re-check with keeperhub-tx status or docs.keeperhub.com/api/direct-execution" });
  }
  const poll = await pollKeeperHubExecution(mode, executionId, { timeoutMs: cfg.timeoutMs });
  return renderKeeperhubTransfer({ params, sent, poll, mode });
}

async function main() {
  const { command, sub, flags } = parseArgs(process.argv.slice(2));
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === "help" || flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const cfg = loadConfig(flags.config ? { configFile: flags.config } : {});
  let out;
  if (command === "discover") out = await cmdDiscover(cfg, flags);
  else if (command === "pools") out = await cmdPools(cfg, flags);
  else if (command === "swaps") out = await cmdSwaps(cfg, flags);
  else if (command === "keeperhub-tx") out = await cmdKeeperhubTx(cfg, flags, sub);
  else {
    process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof ConfigError) {
      process.stderr.write(`error[${err.code}]: ${err.message}\nhint: ${err.hint}\n`);
      process.exit(2);
    }
    if (err instanceof KeeperHubError) {
      process.stderr.write(`error[${err.code}]: ${err.message}\nhint: ${err.hint}\n`);
      process.exit(err.code === "missing_api_key" || err.code === "bad_input" ? 2 : 1);
    }
    if (err instanceof GraphQueryError) {
      process.stderr.write(`error[${err.code}]: ${err.message}\nhint: ${err.hint}\n`);
      process.exit(1);
    }
    process.stderr.write(`error[unexpected]: ${err?.stack ?? err}\n`);
    process.exit(1);
  });

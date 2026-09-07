#!/usr/bin/env node
// GraphPilot MCP server — minimal Model Context Protocol server over stdio.
// Zero dependencies (Node >= 18): newline-delimited JSON-RPC 2.0 on stdin/stdout,
// one message per line, responses in request order. Same provider stack as the CLI
// (src/config.mjs): dry-run via GRAPHPILOT_PROVIDER=dry-run, live via
// GRAPH_STUDIO_KEY / GRAPHPILOT_ENDPOINT / GRAPHPILOT_DEPLOYMENT_ID — fail closed
// with a typed error[missing_api_key] when nothing resolves (never silent mocks).
//
// TODO-VERIFY: framing + protocol shape validated only by tests/mcp-smoke.mjs (our own
// client); needs one round-trip with a real MCP client (Cursor / Claude Desktop) for:
// newline framing vs their transport expectations, protocolVersion negotiation on
// initialize, capabilities/instructions shape, and the tools/call result shape
// (text content only here — no structuredContent yet).

import { createInterface } from "node:readline";
import { loadConfig, resolveProvider, ConfigError } from "../src/config.mjs";
import { runQuery, GraphQueryError } from "../src/client.mjs";
import { DEFAULT_SUBGRAPH_ID, ENDPOINT_MATRIX } from "../src/endpoints.mjs";
import { fmtInt } from "../src/format.mjs";
import {
  loadKeeperHubConfig,
  resolveKeeperHubMode,
  keeperhubTransfer,
  keeperhubStatus,
  pollKeeperHubExecution,
  extractProof,
  keeperhubExecutionTerminal,
  keeperhubParamLine,
  DRY_RUN_TAG,
  KeeperHubError,
} from "../src/keeperhub.mjs";

const SERVER = { name: "graphpilot", version: "0.1.0" };
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const JSON_RPC = { PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 };

// Local registry (no network): the DAY0-NOTES endpoint matrix + the one subgraph id
// the notes actually document. Live/explorer-wide search is not implemented —
// TODO-VERIFY: needs the Subgraph Explorer API or the official Subgraph MCP (#7).
const KNOWN_SUBGRAPHS = [
  { name: "Uniswap V3", id: DEFAULT_SUBGRAPH_ID, network: "mainnet", note: "docs example (DAY0-NOTES) — default target of the pools/swaps ship queries" },
];

class ToolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolInputError";
  }
}

const TOOLS = [
  {
    name: "search_subgraphs",
    description:
      "Find what to query on The Graph. Searches GraphPilot's LOCAL registry only: the DAY0-NOTES endpoint matrix (9 endpoints incl. gateway Bearer, x402, Studio URL) and known subgraph ids. Offline, works without an API key. Live/explorer-wide search is not implemented yet (TODO-VERIFY).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "case-insensitive substring, e.g. 'uniswap', 'gateway', 'x402', 'studio'. Empty = full registry." },
      },
    },
  },
  {
    name: "run_graphql",
    description:
      "Run ONE GraphQL query against the resolved provider — same stack as the graphpilot CLI. Dry-run (labeled mock fixtures, offline) via endpoint_ref='dry-run' or GRAPHPILOT_PROVIDER=dry-run; live needs GRAPH_STUDIO_KEY / GRAPHPILOT_ENDPOINT / GRAPHPILOT_DEPLOYMENT_ID in the server env. Fail closed: with no live provider configured it returns a typed error[missing_api_key], never a silent mock.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint_ref: {
          type: "string",
          enum: ["configured", "dry-run"],
          description: "'configured' (default) = provider resolved from env/config, same precedence as the CLI; 'dry-run' = labeled mock fixtures (offline/CI). TODO-VERIFY: enum naming vs a real client UX.",
        },
        gql: { type: "string", description: "GraphQL query text. Dry-run understands the 3 ship queries (pools/swaps selections) + __schema introspection; anything else returns typed mock_unmatched." },
        vars: { type: "object", description: "optional GraphQL variables, sent as { variables } (TODO-VERIFY: not yet exercised against the live gateway)." },
      },
      required: ["gql"],
    },
  },
  {
    name: "explain_result",
    description:
      "Turn a GraphPilot result (JSON text as returned by run_graphql, or any data JSON) into a compact reasoned summary: shape, row counts, totals, takeaways — never a raw JSON dump. DRY-RUN payloads stay tagged [DRY-RUN MOCK — TODO-VERIFY live].",
    inputSchema: {
      type: "object",
      properties: {
        result_json: { type: "string", description: "result payload as JSON text (or an already-parsed object)." },
      },
      required: ["result_json"],
    },
  },
  {
    name: "keeperhub_transfer",
    description:
      "Route a value transfer through the KeeperHub execution layer (Direct Execution REST) — the value-rail next to GraphPilot's The Graph data-rail; proof = transactionLink + verified receipt. simulate=true (default) only simulates (never broadcasts, never returns a tx hash); simulate=false broadcasts with a canonical Idempotency-Key, polls to a terminal state and returns transactionLink + verified + receiptStatus. Needs KEEPERHUB_KEY (org kh_ key; mcp:write for broadcast — fail closed without it); KEEPERHUB_PROVIDER=dry-run or mode='dry-run' runs the labeled offline mock. Testnet chains are the demo path (e.g. 11155111 Sepolia).",
    inputSchema: {
      type: "object",
      properties: {
        chain_id: { type: "number", description: "target chain id, e.g. 11155111 (Ethereum Sepolia) / 84532 (Base Sepolia) — pick testnets via GET /api/chains (isEnabled && isTestnet)" },
        to: { type: "string", description: "recipient EVM address (0x + 40 hex); Solana paths TODO-VERIFY" },
        amount: { type: "string", description: "transfer amount as a positive decimal string, ETH human units (token decimals TODO-VERIFY; day cap 0.02 ETH EVM)" },
        token: { type: "string", description: "optional ERC-20 token address; omit for a native ETH transfer" },
        simulate: { type: "boolean", description: "true (default) = simulation only; false = broadcast + poll for the onchain proof" },
        mode: { type: "string", enum: ["configured", "dry-run"], description: "'configured' (default) = resolve from env like the CLI; 'dry-run' = labeled offline mock" },
      },
      required: ["chain_id", "to", "amount"],
    },
  },
  {
    name: "keeperhub_tx_status",
    description:
      "Poll one KeeperHub direct execution by executionId: status, X-Poll-Interval-Hint, and — when completed — the proof fields (transactionLink, verified, receiptStatus). 'unconfirmed'/pending is NOT a failure and must never be rebroadcast (idempotency). Fail closed without KEEPERHUB_KEY; dry-run mode returns the labeled mock.",
    inputSchema: {
      type: "object",
      properties: {
        execution_id: { type: "string", description: "executionId as returned by keeperhub_transfer broadcast" },
        mode: { type: "string", enum: ["configured", "dry-run"], description: "same resolution as keeperhub_transfer" },
      },
      required: ["execution_id"],
    },
  },
];

function writeLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function reply(id, result) {
  writeLine({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  writeLine({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolResult(text, isError = false) {
  // TODO-VERIFY: text content only; a live client may also expect structuredContent.
  const res = { content: [{ type: "text", text }] };
  if (isError) res.isError = true;
  return res;
}

function providerLine(cfg) {
  try {
    const p = resolveProvider(cfg, {});
    return `provider: ${p.label}`;
  } catch (e) {
    if (e instanceof ConfigError) {
      return `provider: none — FAIL-CLOSED (error[${e.code}]): run_graphql will refuse until GRAPH_STUDIO_KEY or GRAPHPILOT_ENDPOINT is set (or use endpoint_ref 'dry-run')`;
    }
    throw e;
  }
}

function toolSearchSubgraphs(args, cfg) {
  const q = typeof args?.query === "string" ? args.query.trim() : "";
  const needle = q.toLowerCase();
  const subs = KNOWN_SUBGRAPHS.filter((s) => !needle || `${s.name} ${s.id} ${s.network}`.toLowerCase().includes(needle));
  const eps = ENDPOINT_MATRIX.filter((e) => !needle || `${e.n} ${e.url} ${e.auth} ${e.provider}`.toLowerCase().includes(needle));
  const dryRun = resolveProvider(cfg, { provider: "dry-run" }).dryRun;
  const L = [];
  L.push(`GraphPilot search_subgraphs — local registry${dryRun ? "   [DRY-RUN PROVIDER — TODO-VERIFY live]" : ""}`);
  L.push(providerLine(cfg));
  L.push("");
  if (needle && subs.length === 0 && eps.length === 0) {
    L.push(`no match for "${q}" in the local registry — try: uniswap, gateway, x402, studio, token`);
  } else {
    L.push(`known subgraphs (${subs.length}/${KNOWN_SUBGRAPHS.length}):`);
    for (const s of subs) {
      L.push(`  - ${s.name} · ${s.network} · id ${s.id}`);
      L.push(`    ${s.note}`);
    }
    L.push(`endpoint matrix matches (${eps.length}/${ENDPOINT_MATRIX.length}, DAY0-NOTES):`);
    for (const e of eps) {
      L.push(`  ${String(e.n).padStart(2)}. ${e.url}`);
      L.push(`      auth: ${e.auth}`);
    }
  }
  L.push("");
  L.push("limit: local registry only (DAY0-NOTES); explorer-wide/live search TODO-VERIFY (Explorer API or endpoint #7 MCP).");
  return L.join("\n");
}

async function toolRunGraphql(args, cfg) {
  const gql = typeof args?.gql === "string" ? args.gql : "";
  if (!gql.trim()) throw new ToolInputError("run_graphql needs a non-empty 'gql' string");
  if (args?.vars !== undefined && (typeof args.vars !== "object" || args.vars === null || Array.isArray(args.vars))) {
    throw new ToolInputError("'vars' must be an object of GraphQL variables");
  }
  const endpointRef = args?.endpoint_ref ?? "configured";
  const provider = endpointRef === "dry-run" ? resolveProvider(cfg, { provider: "dry-run" }) : resolveProvider(cfg, {});
  const { data, meta } = await runQuery(provider, gql, { timeoutMs: cfg.timeoutMs, variables: args?.vars });
  const tag = meta.dryRun ? "DRY-RUN MOCK — TODO-VERIFY live" : "LIVE";
  return [`GraphPilot run_graphql [${tag}] via ${provider.label}`, JSON.stringify({ data, meta }, null, 2)].join("\n");
}

function describeShape(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? `array[${v.length}] of ${describeShape(v[0])}` : "array[0]";
  if (typeof v === "object") return `object{${Object.keys(v).join(", ")}}`;
  return typeof v;
}

function numericCols(rows) {
  return Object.keys(rows[0]).filter((k) =>
    rows.every((r) => r?.[k] !== null && r?.[k] !== undefined && r?.[k] !== "" && Number.isFinite(Number(r[k]))),
  );
}

function genericArrayLines(name, rows) {
  const L = [`${name}: ${rows.length} rows; columns: ${Object.keys(rows[0]).join(", ")}`];
  for (const col of numericCols(rows).slice(0, 3)) {
    const nums = rows.map((r) => Number(r[col]));
    L.push(`  ${col}: total ${fmtInt(nums.reduce((a, b) => a + b, 0))}, max ${fmtInt(Math.max(...nums))}`);
  }
  return L;
}

function explainParsed(parsed) {
  const dryRun = parsed?.meta?.dryRun === true;
  const data = parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
  const L = [];
  L.push(`GraphPilot explain_result${dryRun ? "   [DRY-RUN MOCK — TODO-VERIFY live]" : ""}`);
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    L.push(`errors (${parsed.errors.length}): ${parsed.errors.map((e) => e?.message ?? String(e)).join("; ")}`);
    L.push("takeaway: the query failed — fix the GraphQL before interpreting any data.");
    return L.join("\n");
  }
  L.push(`shape: ${describeShape(data)}`);
  let takeaways = 0;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    if (Array.isArray(data.__schema?.queryType?.fields)) {
      const names = data.__schema.queryType.fields.map((f) => f?.name).filter(Boolean);
      L.push(`__schema: ${names.length} root Query fields — ${names.join(", ") || "(none returned)"}`);
    }
    if (Array.isArray(data.pools)) {
      const pools = data.pools;
      L.push(...genericArrayLines("pools", pools));
      if (pools.length > 0) {
        const tvls = pools.map((p) => Number(p.totalValueLockedUSD)).filter(Number.isFinite);
        const total = tvls.reduce((a, b) => a + b, 0);
        const top = pools[0];
        const pair = `${top.token0?.symbol ?? "?"}/${top.token1?.symbol ?? "?"}`;
        const share = total > 0 ? ((Number(top.totalValueLockedUSD) / total) * 100).toFixed(1) : "?";
        L.push(`takeaway: top pool ${pair} = ${share}% of TVL shown ($${fmtInt(total)} across ${pools.length} pools).`);
        takeaways += 1;
      }
    }
    if (Array.isArray(data.swaps)) {
      const swaps = data.swaps;
      L.push(...genericArrayLines("swaps", swaps));
      if (swaps.length > 0) {
        const usds = swaps.map((s) => Number(s.amountUSD)).filter(Number.isFinite).sort((a, b) => a - b);
        const max = usds[usds.length - 1];
        const median = usds.length % 2 ? usds[(usds.length - 1) / 2] : usds[usds.length / 2 - 1];
        const big = swaps.find((s) => Number(s.amountUSD) === max);
        const pair = big ? `${big.pool?.token0?.symbol ?? "?"}/${big.pool?.token1?.symbol ?? "?"}` : "?";
        L.push(`takeaway: largest swap $${fmtInt(max)} on ${pair}; median $${fmtInt(median)} across ${swaps.length} shown.`);
        takeaways += 1;
      }
    }
    for (const [key, value] of Object.entries(data)) {
      if (key === "pools" || key === "swaps" || key === "__schema") continue;
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
        L.push(...genericArrayLines(key, value));
      } else if (value !== null && typeof value === "object") {
        L.push(`${key}: ${describeShape(value)}`);
      } else {
        L.push(`${key}: ${String(value)}`);
      }
    }
  }
  if (takeaways === 0 && !Array.isArray(data?.pools) && !Array.isArray(data?.swaps)) {
    L.push("takeaway: no recognized pools/swaps arrays — treat the shape line above as the summary.");
  }
  return L.join("\n");
}

function toolExplainResult(args) {
  const raw = args?.result_json;
  if (typeof raw !== "string" && typeof raw !== "object") {
    throw new ToolInputError("explain_result needs 'result_json' (JSON text, or an object)");
  }
  let parsed;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new ToolInputError(`result_json is not valid JSON: ${e?.message ?? e}`);
    }
  } else {
    parsed = raw;
  }
  return explainParsed(parsed);
}

// --- KeeperHub value-rail tools (src/keeperhub.mjs; fail-closed without KEEPERHUB_KEY) ---

function keeperhubModeFor(args) {
  return resolveKeeperHubMode(loadKeeperHubConfig(), { provider: args?.mode === "dry-run" ? "dry-run" : undefined });
}

function keeperhubTransferArgs(args) {
  const chainId = Number(args?.chain_id);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new ToolInputError("'chain_id' must be a positive integer (e.g. 11155111 = Ethereum Sepolia, 84532 = Base Sepolia)");
  }
  const to = typeof args?.to === "string" ? args.to.trim() : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new ToolInputError("'to' must be an EVM address (0x + 40 hex) — Solana paths TODO-VERIFY");
  }
  const amount = typeof args?.amount === "number" ? String(args.amount) : typeof args?.amount === "string" ? args.amount.trim() : "";
  if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new ToolInputError("'amount' must be a positive decimal string (ETH human units; token decimals TODO-VERIFY)");
  }
  const token = typeof args?.token === "string" ? args.token.trim() : "";
  if (token && !/^0x[0-9a-fA-F]{40}$/.test(token)) {
    throw new ToolInputError("'token' must be an ERC-20 address (0x + 40 hex), or omit it for a native ETH transfer");
  }
  return { chainId, to, amount, tokenAddress: token };
}

async function toolKeeperhubTransfer(args, cfg) {
  const params = keeperhubTransferArgs(args);
  const simulate = args?.simulate !== false; // default true — never broadcast unless explicitly asked
  const mode = keeperhubModeFor(args);
  const tag = mode.dryRun ? `   ${DRY_RUN_TAG}` : "";
  if (simulate) {
    const res = await keeperhubTransfer(mode, { ...params, simulate: true }, { timeoutMs: cfg.timeoutMs });
    return [
      `GraphPilot keeperhub_transfer (simulate only)${tag}`,
      `mode: ${mode.label}`,
      keeperhubParamLine(params),
      `result: success=${res?.success ?? "?"} wouldRevert=${res?.wouldRevert ?? "?"} — nothing broadcast, no tx hash by design`,
    ].join("\n");
  }
  const sent = await keeperhubTransfer(mode, { ...params, simulate: false }, { timeoutMs: cfg.timeoutMs });
  const executionId = sent?.executionId ?? sent?.id ?? null;
  if (!executionId) {
    throw new KeeperHubError({ code: "bad_response", message: "broadcast accepted but no executionId in the response — TODO-VERIFY live shape", hint: "re-check with keeperhub_tx_status or docs.keeperhub.com/api/direct-execution" });
  }
  const poll = await pollKeeperHubExecution(mode, executionId, { timeoutMs: cfg.timeoutMs });
  const proof = extractProof(poll?.body ?? sent);
  const L = [
    `GraphPilot keeperhub_transfer (broadcast + poll)${tag}`,
    `mode: ${mode.label}`,
    keeperhubParamLine(params),
    `executionId: ${executionId}`,
  ];
  if (poll?.terminal) {
    L.push(`status: "${proof.status}" (terminal after ${poll.attempts} poll(s))`);
    L.push(`receipt: verified=${proof.verified} receiptStatus="${proof.receiptStatus || "?"}"`);
    if (proof.completed && proof.verified) {
      L.push(`transactionLink: ${proof.transactionLink ?? "?"}`);
      L.push("^ onchain proof — keep transactionLink from the terminal response (testnet accepted)");
    } else {
      L.push(`transactionLink: ${proof.transactionLink ?? "(none)"} — terminal without a verified success receipt; do NOT present as tx-proof`);
    }
  } else {
    L.push(`status: "${proof.status || "?"}" — NOT terminal after ${poll?.attempts ?? 0} poll(s)`);
    L.push("unconfirmed is NOT a failure: re-poll with keeperhub_tx_status; never rebroadcast with a new Idempotency-Key");
  }
  return L.join("\n");
}

async function toolKeeperhubTxStatus(args, cfg) {
  const executionId = typeof args?.execution_id === "string" ? args.execution_id.trim() : "";
  if (!executionId) {
    throw new ToolInputError("'execution_id' is required (returned by the keeperhub_transfer broadcast)");
  }
  const mode = keeperhubModeFor(args);
  const res = await keeperhubStatus(mode, executionId, { timeoutMs: cfg.timeoutMs });
  const proof = extractProof(res.body);
  const tag = mode.dryRun ? `   ${DRY_RUN_TAG}` : "";
  const L = [
    `GraphPilot keeperhub_tx_status${tag}`,
    `mode: ${mode.label}`,
    `executionId: ${executionId}`,
    `status: "${proof.status || "?"}" · pollIntervalHint: ${res.pollIntervalHint}s (0 = terminal)`,
    `receipt: verified=${proof.verified} receiptStatus="${proof.receiptStatus || "?"}"`,
  ];
  if (proof.transactionLink) L.push(`transactionLink: ${proof.transactionLink}`);
  if (proof.completed && proof.verified) {
    L.push("^ onchain proof — safe to record as the tx-link");
  } else if (!keeperhubExecutionTerminal(proof.status)) {
    L.push("not terminal yet — poll again later; unconfirmed is NOT a failure and must never be rebroadcast");
  } else {
    L.push("WARNING: terminal without a verified success receipt — do NOT present as tx-proof");
  }
  return L.join("\n");
}

async function callTool(name, args, cfg) {
  if (name === "search_subgraphs") return toolSearchSubgraphs(args, cfg);
  if (name === "run_graphql") return toolRunGraphql(args, cfg);
  if (name === "explain_result") return toolExplainResult(args);
  if (name === "keeperhub_transfer") return toolKeeperhubTransfer(args, cfg);
  if (name === "keeperhub_tx_status") return toolKeeperhubTxStatus(args, cfg);
  return null;
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification — never answered (e.g. notifications/initialized)
  if (!method) {
    replyError(id, JSON_RPC.INVALID_REQUEST, "missing method");
    return;
  }
  if (method === "initialize") {
    // TODO-VERIFY: echo the client's version when we support it, else advertise our
    // default — confirm this negotiation against a real client (spec allows either
    // side to disconnect on a mismatch).
    const requested = params?.protocolVersion;
    const protocolVersion =
      typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
    reply(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER,
      instructions:
        "GraphPilot: live Subgraph queries on The Graph. Start with search_subgraphs (offline registry), dry-run first (GRAPHPILOT_PROVIDER=dry-run or run_graphql endpoint_ref='dry-run'), then run_graphql live with a key, then explain_result for the summary. DRY-RUN output is always tagged — never present it as live. keeperhub_transfer / keeperhub_tx_status are the value-rail: simulate first, broadcast only on purpose, proof = transactionLink + verified receiptStatus; they fail closed without KEEPERHUB_KEY.",
    });
    return;
  }
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (!TOOLS.some((t) => t.name === name)) {
      replyError(id, JSON_RPC.INVALID_PARAMS, `unknown tool: ${JSON.stringify(name ?? null)}`);
      return;
    }
    const cfg = loadConfig();
    try {
      const text = await callTool(name, params?.arguments ?? {}, cfg);
      reply(id, toolResult(text));
    } catch (e) {
      if (e instanceof ToolInputError) {
        reply(id, toolResult(`error[bad_input]: ${e.message}`, true));
      } else if (e instanceof ConfigError || e instanceof GraphQueryError || e instanceof KeeperHubError) {
        reply(id, toolResult(`error[${e.code}]: ${e.message}\nhint: ${e.hint}`, true));
      } else {
        reply(id, toolResult(`error[unexpected]: ${e?.message ?? e}`, true));
      }
    }
    return;
  }
  replyError(id, JSON_RPC.METHOD_NOT_FOUND, `method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    replyError(null, JSON_RPC.PARSE_ERROR, "parse error: line is not valid JSON");
    return;
  }
  if (Array.isArray(msg)) {
    replyError(null, JSON_RPC.INVALID_REQUEST, "batch requests not supported — one JSON-RPC message per line");
    return;
  }
  handleMessage(msg).catch((e) => {
    replyError(msg?.id ?? null, JSON_RPC.INTERNAL, `internal error: ${e?.message ?? e}`);
  });
});
rl.on("close", () => process.exit(0));

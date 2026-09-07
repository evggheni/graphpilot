// MCP smoke suite — offline only (dry-run provider / fail-closed, never network).
// Spawns mcp/server.mjs, speaks newline-delimited JSON-RPC 2.0 over stdio and asserts
// initialize / tools/list / tools/call round-trips. Run: npm run test:mcp (or: node tests/mcp-smoke.mjs)

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { poolsQuery } from "../src/queries.mjs";
import { POOLS_FIXTURES } from "../src/fixtures.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(repoRoot, "mcp", "server.mjs");

// Isolate from the parent shell: empty GRAPHPILOT_CONFIG ("") disables config.json auto-load;
// KEEPERHUB_* emptied so the keeperhub tools fail closed deterministically in CI.
const BASE_ENV = {
  GRAPHPILOT_CONFIG: "",
  GRAPH_STUDIO_KEY: "",
  GRAPHPILOT_ENDPOINT: "",
  GRAPHPILOT_DEPLOYMENT_ID: "",
  GRAPHPILOT_SUBGRAPH_ID: "",
  KEEPERHUB_KEY: "",
  KEEPERHUB_API: "",
  KEEPERHUB_PROVIDER: "",
};

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, ...BASE_ENV, ...extraEnv },
  });
  const messages = [];
  const waiters = new Map();
  let nextId = 0;
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
      messages.push({ __unparseable: s });
      return;
    }
    messages.push(msg);
    const w = waiters.get(msg.id);
    if (w) {
      waiters.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) {
        const err = new Error(`jsonrpc ${msg.error.code}: ${msg.error.message}`);
        err.code = msg.error.code;
        w.reject(err);
      } else {
        w.resolve(msg.result);
      }
    }
  });
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        if (waiters.has(id)) {
          waiters.delete(id);
          reject(new Error(`timeout: no response to ${method} within 10s`));
        }
      }, 10000);
      waiters.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  return {
    child,
    messages,
    request,
    notify,
    stop: () => {
      try { child.stdin.end(); } catch {}
      child.kill();
    },
  };
}

function textOf(result) {
  assert.ok(Array.isArray(result?.content) && result.content.length > 0, "tools/call result must carry content[]");
  assert.equal(result.content[0].type, "text");
  return result.content[0].text;
}

let pass = 0;
let fail = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail += 1;
    failures.push(`${name}: ${e?.message ?? e}`);
    console.log(`FAIL ${name}\n     ${e?.message ?? e}`);
  }
}

const dry = startServer({ GRAPHPILOT_PROVIDER: "dry-run" });

await t("mcp initialize: serverInfo + tools capability + protocolVersion echo", async () => {
  const res = await dry.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-smoke", version: "0.0.0" },
  });
  assert.equal(res.serverInfo.name, "graphpilot");
  assert.equal(typeof res.serverInfo.version, "string");
  assert.equal(res.protocolVersion, "2025-06-18");
  assert.ok(res.capabilities && typeof res.capabilities.tools === "object", "capabilities.tools expected");
});

await t("mcp notifications get no response (notifications/initialized)", async () => {
  const before = dry.messages.length;
  dry.notify("notifications/initialized");
  await dry.request("ping"); // response ordering: ping must be the ONLY new message
  assert.equal(dry.messages.length, before + 1, `expected only the ping response, got ${dry.messages.length - before}`);
  assert.deepEqual(dry.messages.at(-1).result, {});
});

await t("mcp tools/list: exactly the 5 graphpilot tools with object schemas", async () => {
  const res = await dry.request("tools/list");
  const names = res.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["explain_result", "keeperhub_transfer", "keeperhub_tx_status", "run_graphql", "search_subgraphs"]);
  for (const tool of res.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.description.length > 20, `tool ${tool.name} needs a real description`);
  }
  assert.ok(res.tools.find((tool) => tool.name === "run_graphql").inputSchema.required.includes("gql"));
  assert.ok(res.tools.find((tool) => tool.name === "explain_result").inputSchema.required.includes("result_json"));
  assert.deepEqual(res.tools.find((tool) => tool.name === "keeperhub_transfer").inputSchema.required, ["chain_id", "to", "amount"]);
  assert.deepEqual(res.tools.find((tool) => tool.name === "keeperhub_tx_status").inputSchema.required, ["execution_id"]);
});

await t("mcp tools/call search_subgraphs 'uniswap' (dry-run): registry hit + DRY-RUN tag", async () => {
  const res = await dry.request("tools/call", { name: "search_subgraphs", arguments: { query: "uniswap" } });
  assert.notEqual(res.isError, true);
  const text = textOf(res);
  assert.match(text, /Uniswap V3/);
  assert.match(text, /5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV/);
  assert.match(text, /DRY-RUN/);
  assert.match(text, /endpoint matrix matches/i);
});

await t("mcp tools/call run_graphql (dry-run): pools fixture round-trips as JSON with tag", async () => {
  const res = await dry.request("tools/call", {
    name: "run_graphql",
    arguments: { endpoint_ref: "dry-run", gql: poolsQuery({ first: 2 }) },
  });
  assert.notEqual(res.isError, true);
  const text = textOf(res);
  assert.match(text, /DRY-RUN MOCK — TODO-VERIFY live/);
  assert.match(text, /"pools"/);
  assert.ok(text.includes(POOLS_FIXTURES[0].id), "fixture pool id expected in run_graphql output");
});

await t("mcp tools/call run_graphql (dry-run): unknown query -> isError with typed mock_unmatched", async () => {
  const res = await dry.request("tools/call", {
    name: "run_graphql",
    arguments: { endpoint_ref: "dry-run", gql: "{ frobnicators { id } }" },
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /error\[mock_unmatched\]/);
});

await t("mcp tools/call explain_result: reasoned summary with takeaway, DRY-RUN tagged", async () => {
  const payload = { data: { pools: POOLS_FIXTURES.slice(0, 3) }, meta: { dryRun: true } };
  const res = await dry.request("tools/call", {
    name: "explain_result",
    arguments: { result_json: JSON.stringify(payload) },
  });
  assert.notEqual(res.isError, true);
  const text = textOf(res);
  assert.match(text, /DRY-RUN MOCK — TODO-VERIFY live/);
  assert.match(text, /pools: 3 rows/i);
  assert.match(text, /takeaway:/i);
  assert.match(text, /WETH\/USDC/);
  assert.ok(!text.includes('"token0"'), "summary must not re-dump raw rows");
});

await t("mcp tools/call explain_result: invalid JSON -> isError error[bad_input]", async () => {
  const res = await dry.request("tools/call", { name: "explain_result", arguments: { result_json: "{not json" } });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /error\[bad_input\]/);
});

await t("mcp tools/call run_graphql: missing gql -> isError error[bad_input]", async () => {
  const res = await dry.request("tools/call", { name: "run_graphql", arguments: { endpoint_ref: "dry-run" } });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /error\[bad_input\]/);
});

await t("mcp tools/call keeperhub_transfer (mode dry-run): simulate only, tagged, no tx hash by design", async () => {
  const res = await dry.request("tools/call", {
    name: "keeperhub_transfer",
    arguments: { chain_id: 11155111, to: "0xAbC0000000000000000000000000000000000001", amount: "0.0001", mode: "dry-run" },
  });
  assert.notEqual(res.isError, true);
  const text = textOf(res);
  assert.match(text, /\[DRY-RUN MOCK — TODO-VERIFY live\]/);
  assert.match(text, /simulate only/);
  assert.match(text, /success=true wouldRevert=false/);
  assert.match(text, /no tx hash by design/);
});

await t("mcp tools/call keeperhub_transfer simulate=false (mode dry-run): broadcast + poll -> proof fields", async () => {
  const res = await dry.request("tools/call", {
    name: "keeperhub_transfer",
    arguments: { chain_id: 11155111, to: "0xAbC0000000000000000000000000000000000001", amount: "0.0001", simulate: false, mode: "dry-run" },
  });
  assert.notEqual(res.isError, true);
  const text = textOf(res);
  assert.match(text, /broadcast \+ poll/);
  assert.match(text, /transactionLink: https:\/\/dry-run-mock\.invalid\//);
  assert.match(text, /verified=true receiptStatus="success"/);
  assert.match(text, /DRY-RUN MOCK/);
});

await t("mcp unknown method -> JSON-RPC error -32601", async () => {
  await assert.rejects(dry.request("resources/list"), (e) => e.code === -32601);
});

await t("mcp unknown tool -> JSON-RPC error -32602", async () => {
  await assert.rejects(dry.request("tools/call", { name: "nope", arguments: {} }), (e) => e.code === -32602);
});

dry.stop();

const locked = startServer({}); // no provider of any kind

await t("mcp fail-closed: run_graphql without key -> isError error[missing_api_key] (never silent mock)", async () => {
  const res = await locked.request("tools/call", { name: "run_graphql", arguments: { gql: poolsQuery() } });
  assert.equal(res.isError, true);
  const text = textOf(res);
  assert.match(text, /error\[missing_api_key\]/);
  assert.match(text, /hint:/);
});

await t("mcp search_subgraphs still answers without key, honestly tagged fail-closed", async () => {
  const res = await locked.request("tools/call", { name: "search_subgraphs", arguments: { query: "uniswap" } });
  assert.notEqual(res.isError, true);
  const text = textOf(res);
  assert.match(text, /missing_api_key/);
  assert.match(text, /FAIL-CLOSED/i);
  assert.match(text, /Uniswap V3/);
});

await t("mcp fail-closed: keeperhub_transfer without KEEPERHUB_KEY -> isError error[missing_api_key] (never silent mock)", async () => {
  const res = await locked.request("tools/call", {
    name: "keeperhub_transfer",
    arguments: { chain_id: 11155111, to: "0xAbC0000000000000000000000000000000000001", amount: "0.0001" },
  });
  assert.equal(res.isError, true);
  const text = textOf(res);
  assert.match(text, /error\[missing_api_key\]/);
  assert.match(text, /KEEPERHUB_KEY/);
  assert.match(text, /hint:/);
});

await t("mcp keeperhub_tx_status: bad_input without execution_id; dry-run mode returns the tagged mock proof", async () => {
  const bad = await locked.request("tools/call", { name: "keeperhub_tx_status", arguments: {} });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /error\[bad_input\]/);
  const ok = await locked.request("tools/call", { name: "keeperhub_tx_status", arguments: { execution_id: "kh_dryrun_x", mode: "dry-run" } });
  assert.notEqual(ok.isError, true);
  const text = textOf(ok);
  assert.match(text, /status: "completed"/);
  assert.match(text, /verified=true receiptStatus="success"/);
  assert.match(text, /DRY-RUN MOCK/);
});

locked.stop();

console.log(`\nmcp-smoke: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

// Offline smoke suite — dry-run provider + labeled mock fixtures only (never network).
// Run: npm test   (or: node tests/smoke.mjs)

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, resolveProvider, ConfigError } from "../src/config.mjs";
import { runQuery, GraphQueryError } from "../src/client.mjs";
import { poolsQuery, swapsQuery, SCHEMA_PROBE_QUERY, clampQueryArgs } from "../src/queries.mjs";
import { POOLS_FIXTURES, SWAPS_FIXTURES } from "../src/fixtures.mjs";
import { renderPoolsResult, renderSwapsResult, renderDiscoverResult } from "../src/format.mjs";
import { gatewayBearerUrl, gatewayDeploymentUrl, ENDPOINT_MATRIX } from "../src/endpoints.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(repoRoot, "bin", "graphpilot.mjs");
const ENV_LIVE = { ...process.env, GRAPH_STUDIO_KEY: "test-key-smoke", GRAPHPILOT_ENDPOINT: "", GRAPHPILOT_PROVIDER: "", GRAPHPILOT_DEPLOYMENT_ID: "" };
const ENV_NONE = { ...process.env, GRAPH_STUDIO_KEY: "", GRAPHPILOT_ENDPOINT: "", GRAPHPILOT_PROVIDER: "", GRAPHPILOT_DEPLOYMENT_ID: "" };

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

await t("resolveProvider: explicit dry-run flag wins and is labeled", () => {
  const p = resolveProvider(loadConfig({ env: ENV_LIVE }), { provider: "dry-run" });
  assert.equal(p.kind, "dry-run");
  assert.equal(p.dryRun, true);
  assert.match(p.label, /dry-run/i);
});

await t("resolveProvider: GRAPH_STUDIO_KEY -> gateway-bearer endpoint #2 (Bearer header, no key in URL)", () => {
  const p = resolveProvider(loadConfig({ env: ENV_LIVE }), {});
  assert.equal(p.kind, "gateway-bearer");
  assert.equal(p.url, gatewayBearerUrl("5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV"));
  assert.equal(p.headers.authorization, "Bearer test-key-smoke");
  assert.ok(!p.url.includes("test-key-smoke"), "key must not leak into URL");
});

await t("resolveProvider: GRAPHPILOT_ENDPOINT -> keyless studio-url (#6)", () => {
  const env = { ...ENV_NONE, GRAPHPILOT_ENDPOINT: "https://api.studio.thegraph.com/query/99/graphpilot-demo/v0.0.1" };
  const p = resolveProvider(loadConfig({ env }), {});
  assert.equal(p.kind, "studio-url");
  assert.deepEqual(p.headers, {});
});

await t("resolveProvider: deploymentId + key -> pinned gateway deployment (#3)", () => {
  const env = { ...ENV_LIVE, GRAPHPILOT_DEPLOYMENT_ID: "QmdEpV2v4FvisibleDeploymentHash" };
  const p = resolveProvider(loadConfig({ env }), {});
  assert.equal(p.kind, "gateway-deployment");
  assert.equal(p.url, gatewayDeploymentUrl("QmdEpV2v4FvisibleDeploymentHash"));
});

await t("resolveProvider: no credentials -> typed missing_api_key (fail closed)", () => {
  assert.throws(() => resolveProvider(loadConfig({ env: ENV_NONE }), {}), (e) => e instanceof ConfigError && e.code === "missing_api_key");
});

await t("queries: DAY0-NOTES selections verbatim + first/skip parameterization", () => {
  assert.equal(
    poolsQuery(),
    '{ pools(first: 5, skip: 0, orderBy: totalValueLockedUSD, orderDirection: desc) { id token0 { symbol } token1 { symbol } totalValueLockedUSD volumeUSD } }',
  );
  assert.equal(
    swapsQuery(),
    '{ swaps(first: 5, skip: 0, orderBy: timestamp, orderDirection: desc) { timestamp amount0 amount1 amountUSD pool { token0 { symbol } token1 { symbol } } } }',
  );
  const q = poolsQuery(clampQueryArgs({ page: 2, limit: 3 }));
  assert.ok(q.includes("first: 3") && q.includes("skip: 3"), `page 2 limit 3 -> first 3 skip 3, got: ${q}`);
});

await t("dry-run client: mock router slices fixtures by first/skip", async () => {
  const p = resolveProvider(loadConfig({ env: ENV_NONE }), { provider: "dry-run" });
  const { data, meta } = await runQuery(p, poolsQuery({ first: 3, skip: 2 }), {});
  assert.equal(meta.dryRun, true);
  assert.equal(data.pools.length, 3);
  assert.equal(data.pools[0].id, POOLS_FIXTURES[2].id);
  const swaps = await runQuery(p, swapsQuery({ first: 2, skip: 0 }), {});
  assert.deepEqual(swaps.data.swaps, SWAPS_FIXTURES.slice(0, 2));
});

await t("fixtures: shapes mirror the query selections (strings for numerics, symbol objects)", () => {
  for (const p of POOLS_FIXTURES) {
    assert.equal(typeof p.id, "string");
    assert.equal(typeof p.token0.symbol, "string");
    assert.equal(typeof p.token1.symbol, "string");
    assert.equal(typeof p.totalValueLockedUSD, "string");
    assert.equal(typeof p.volumeUSD, "string");
  }
  for (const s of SWAPS_FIXTURES) {
    assert.equal(typeof s.timestamp, "string");
    assert.equal(typeof s.amountUSD, "string");
    assert.equal(typeof s.pool.token0.symbol, "string");
  }
});

await t("schema probe: spec introspection round-trips through dry-run", async () => {
  const p = resolveProvider(loadConfig({ env: ENV_NONE }), { provider: "dry-run" });
  const { data } = await runQuery(p, SCHEMA_PROBE_QUERY, {});
  assert.ok(data.__schema.queryType.fields.some((f) => f.name === "pools"));
  assert.ok(data.__schema.queryType.fields.some((f) => f.name === "swaps"));
});

await t("format: pools page renders table + takeaway + paging, no raw JSON dump", () => {
  const out = renderPoolsResult({
    data: { pools: POOLS_FIXTURES.slice(0, 2) },
    provider: resolveProvider(loadConfig({ env: ENV_NONE }), { provider: "dry-run" }),
    subgraphId: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
    page: 1,
    limit: 2,
    dryRun: true,
  });
  assert.ok(out.includes("DRY-RUN MOCK — TODO-VERIFY live"));
  assert.ok(out.includes("WETH/USDC"));
  assert.ok(out.includes("312,451,889"));
  assert.ok(out.includes("takeaway:"));
  assert.ok(out.includes("page 1"));
  assert.ok(!out.trimStart().startsWith("{"), "must be ASCII report, not a JSON dump");
});

await t("format: swaps takeaway reports largest swap", () => {
  const out = renderSwapsResult({
    data: { swaps: SWAPS_FIXTURES.slice(0, 3) },
    provider: { kind: "dry-run", dryRun: true, label: "dry-run" },
    subgraphId: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
    page: 1,
    limit: 3,
    dryRun: true,
  });
  assert.ok(out.includes("46,875"), `largest swap USD expected, got: ${out}`);
  assert.ok(out.includes("TIME UTC"));
});

await t("format: discover lists all 9 DAY0-NOTES endpoints", () => {
  const out = renderDiscoverResult({
    subgraphId: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
    provider: { kind: "dry-run", dryRun: true, label: "dry-run" },
    fields: ["pools", "swaps"],
    matrix: ENDPOINT_MATRIX,
    dryRun: true,
  });
  assert.equal((out.match(/https?:\/\//g) ?? []).length >= 9, true);
  assert.ok(out.includes("x402"));
  assert.ok(out.includes("TODO-VERIFY"));
});

await t("config.example.json: parses, no secrets inside", () => {
  const cfg = JSON.parse(readFileSync(path.join(repoRoot, "config.example.json"), "utf8"));
  for (const [k, v] of Object.entries(cfg)) {
    if (/key|token|secret|jwt/i.test(k)) {
      assert.ok(!v, `secret-like field ${k} must be empty in example config`);
    }
  }
  assert.equal(cfg.subgraphId, "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV");
});

await t("CLI e2e: pools --provider dry-run exits 0 with labeled mock output", () => {
  const r = spawnSync(process.execPath, [BIN, "pools", "--provider", "dry-run"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("DRY-RUN MOCK"));
  assert.ok(r.stdout.includes("WETH/USDC"));
  assert.ok(r.stdout.includes("takeaway:"));
});

await t("CLI e2e: swaps --page 2 --limit 3 exits 0 and pages", () => {
  const r = spawnSync(process.execPath, [BIN, "swaps", "--provider", "dry-run", "--page", "2", "--limit", "3"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("page 2"));
  assert.ok(r.stdout.includes("first: 3, skip: 3"));
});

await t("CLI e2e: discover --provider dry-run lists matrix + probe", () => {
  const r = spawnSync(process.execPath, [BIN, "discover", "--provider", "dry-run"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("gateway.thegraph.com"));
  assert.ok(r.stdout.includes("Query fields (11)"));
});

await t("CLI e2e: no credentials -> exit 2 with typed missing_api_key on stderr", () => {
  const r = spawnSync(process.execPath, [BIN, "pools"], { cwd: repoRoot, encoding: "utf8", env: ENV_NONE });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("error[missing_api_key]"));
  assert.ok(r.stderr.includes("--provider dry-run"));
});

await t("CLI e2e: unknown command -> exit 2 + usage on stderr", () => {
  const r = spawnSync(process.execPath, [BIN, "frobnicate"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("unknown command"));
});

await t("client: live path surfaces typed GraphQL errors (fake fetch)", async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: "subgraph t out of range" }] }) });
  const p = resolveProvider(loadConfig({ env: ENV_LIVE }), {});
  await assert.rejects(
    runQuery(p, poolsQuery(), { fetchImpl: fakeFetch }),
    (e) => e instanceof GraphQueryError && e.code === "graphql_errors",
  );
});

await t("client: live path maps HTTP 429 to typed http_429 (fake fetch)", async () => {
  const fakeFetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const p = resolveProvider(loadConfig({ env: ENV_LIVE }), {});
  await assert.rejects(
    runQuery(p, poolsQuery(), { fetchImpl: fakeFetch }),
    (e) => e instanceof GraphQueryError && e.code === "http_429",
  );
});

console.log(`\nsmoke: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

// KeeperHub smoke suite — offline only (dry-run mocks / fake fetch / fail-closed, never network).
// Covers the dry-run path end-to-end, typed errors, the canonical Idempotency-Key, poll
// semantics (unconfirmed never rebroadcast) and the proof shape (transactionLink + verified +
// receiptStatus). Run: npm run test:keeperhub (or: node tests/keeperhub-smoke.mjs)

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadKeeperHubConfig,
  resolveKeeperHubMode,
  keeperhubTransfer,
  keeperhubStatus,
  pollKeeperHubExecution,
  extractProof,
  idempotencyKey,
  keeperhubParamLine,
  renderKeeperhubSimulate,
  renderKeeperhubTransfer,
  renderKeeperhubStatus,
  KeeperHubError,
} from "../src/keeperhub.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(repoRoot, "bin", "graphpilot.mjs");

const ENV_KEY = { ...process.env, KEEPERHUB_KEY: "kh_test_key", KEEPERHUB_API: "", KEEPERHUB_PROVIDER: "" };
const ENV_NONE = { ...process.env, KEEPERHUB_KEY: "", KEEPERHUB_API: "", KEEPERHUB_PROVIDER: "" };

const PARAMS = { chainId: 11155111, to: "0xAbC0000000000000000000000000000000000001", amount: "0.0001", tokenAddress: "" };
const DRY_MODE = () => resolveKeeperHubMode(loadKeeperHubConfig({ env: ENV_NONE }), { provider: "dry-run" });
const LIVE_MODE = () => resolveKeeperHubMode(loadKeeperHubConfig({ env: ENV_KEY }), {});

function jsonRes(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
  };
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

await t("config: KEEPERHUB_KEY/KEEPERHUB_API from env only, trailing slash trimmed, key never in a URL", () => {
  const cfg = loadKeeperHubConfig({ env: { KEEPERHUB_KEY: "kh_x", KEEPERHUB_API: "https://kh.example/api/" } });
  assert.equal(cfg.apiKey, "kh_x");
  assert.equal(cfg.apiBase, "https://kh.example/api");
  assert.equal(loadKeeperHubConfig({ env: {} }).apiKey, "");
  assert.equal(loadKeeperHubConfig({ env: {} }).apiBase, "https://api.keeperhub.com"); // default — TODO-VERIFY
});

await t("mode: explicit dry-run wins and is labeled (TODO-VERIFY live)", () => {
  const m = DRY_MODE();
  assert.equal(m.dryRun, true);
  assert.match(m.label, /dry-run/i);
});

await t("mode: no key -> typed missing_api_key (fail closed, never silent mock)", () => {
  assert.throws(
    () => resolveKeeperHubMode(loadKeeperHubConfig({ env: ENV_NONE }), {}),
    (e) => e instanceof KeeperHubError && e.code === "missing_api_key" && /KEEPERHUB_KEY/.test(e.hint),
  );
});

await t("mode: key -> live Bearer mode against the configured API base", () => {
  const m = LIVE_MODE();
  assert.equal(m.dryRun, false);
  assert.equal(m.apiBase, "https://api.keeperhub.com");
  assert.equal(m.headers.authorization, "Bearer kh_test_key");
});

await t("idempotency-key: 64-hex SHA-256, address case-insensitive, sensitive to amount/token/task", () => {
  const base = { taskId: "t1", chainId: 11155111, to: PARAMS.to, amount: "0.0001", tokenAddress: "" };
  const k1 = idempotencyKey(base);
  const k2 = idempotencyKey({ ...base, to: PARAMS.to.toLowerCase() });
  assert.match(k1, /^[0-9a-f]{64}$/);
  assert.equal(k1, k2, "same effect fields must derive the same key (no double-spend on retry)");
  assert.notEqual(k1, idempotencyKey({ ...base, amount: "0.0002" }));
  assert.notEqual(k1, idempotencyKey({ ...base, tokenAddress: "0x" + "a".repeat(40) }));
  assert.notEqual(k1, idempotencyKey({ ...base, taskId: "t2" }));
});

await t("dry-run transfer: completed + verified success receipt + .invalid link, tagged via meta", async () => {
  const res = await keeperhubTransfer(DRY_MODE(), { ...PARAMS, simulate: false });
  assert.equal(res.meta.dryRun, true);
  assert.equal(res.status, "completed");
  const r = res.receipts.find((x) => x.verified === true && x.receiptStatus === "success");
  assert.ok(r, "verified success receipt expected");
  assert.match(r.transactionLink, /^https:\/\/dry-run-mock\.invalid\//);
  const proof = extractProof(res);
  assert.equal(proof.completed, true);
  assert.equal(proof.verified, true);
  assert.equal(proof.receiptStatus, "success");
  assert.ok(proof.transactionLink);
  assert.ok(proof.executionId);
});

await t("dry-run simulate: success=true wouldRevert=false, no tx hash by design", async () => {
  const res = await keeperhubTransfer(DRY_MODE(), { ...PARAMS, simulate: true });
  assert.equal(res.meta.dryRun, true);
  assert.equal(res.success, true);
  assert.equal(res.wouldRevert, false);
  assert.equal(res.transactionHash, undefined);
  assert.equal(res.receipts, undefined);
});

await t("live transfer (fake fetch): POST /api/execute/transfer, Bearer + Idempotency-Key on broadcast only, simulate strictly boolean", async () => {
  let captured = null;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return jsonRes(202, { executionId: "kh_e1", status: "pending" });
  };
  const res = await keeperhubTransfer(LIVE_MODE(), { ...PARAMS, simulate: false, taskId: "t1" }, { fetchImpl: fakeFetch });
  assert.equal(captured.url, "https://api.keeperhub.com/api/execute/transfer");
  assert.equal(captured.opts.method, "POST");
  assert.equal(captured.opts.headers.authorization, "Bearer kh_test_key");
  assert.equal(captured.opts.headers["idempotency-key"], idempotencyKey({ taskId: "t1", ...PARAMS }));
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.chainId, 11155111);
  assert.equal(body.recipientAddress, PARAMS.to.toLowerCase());
  assert.equal(body.amount, "0.0001");
  assert.equal(body.simulate, false);
  assert.equal(res.executionId, "kh_e1");
  assert.equal(res.meta.dryRun, false);
  await keeperhubTransfer(LIVE_MODE(), { ...PARAMS, simulate: true }, { fetchImpl: fakeFetch });
  const simBody = JSON.parse(captured.opts.body);
  assert.equal(simBody.simulate, true);
  assert.equal(captured.opts.headers["idempotency-key"], undefined, "simulate never broadcasts -> no Idempotency-Key");
});

await t("typed errors: 401/403/429, 422 -> wallet_not_configured, 400 carries simulate diagnostics", async () => {
  const cases = [
    [401, {}, "http_401"],
    [403, {}, "http_403"],
    [429, {}, "http_429"],
    [422, { message: "WALLET_NOT_CONFIGURED" }, "wallet_not_configured"],
  ];
  for (const [status, body, code] of cases) {
    await assert.rejects(
      keeperhubTransfer(LIVE_MODE(), { ...PARAMS, simulate: true }, { fetchImpl: async () => jsonRes(status, body) }),
      (e) => e instanceof KeeperHubError && e.code === code && e.hint.length > 0,
    );
  }
  await assert.rejects(
    keeperhubTransfer(LIVE_MODE(), { ...PARAMS, simulate: true }, { fetchImpl: async () => jsonRes(400, { message: "amount exceeds daily cap" }) }),
    (e) => e instanceof KeeperHubError && e.code === "http_400" && e.message.includes("amount exceeds daily cap"),
  );
});

await t("status: dry-run mock, live GET path, X-Poll-Interval-Hint parsed (0 when absent), bad_input on empty id", async () => {
  const dry = await keeperhubStatus(DRY_MODE(), "kh_dryrun_x");
  assert.equal(dry.meta.dryRun, true);
  assert.equal(dry.body.status, "completed");
  assert.equal(dry.pollIntervalHint, 0);
  let url = "";
  const fake = async (u) => {
    url = u;
    return jsonRes(200, { executionId: "kh_e1", status: "unconfirmed" }, { "x-poll-interval-hint": "2" });
  };
  const live = await keeperhubStatus(LIVE_MODE(), "kh_e1", { fetchImpl: fake });
  assert.equal(url, "https://api.keeperhub.com/api/execute/kh_e1/status");
  assert.equal(live.pollIntervalHint, 2);
  assert.equal(live.body.status, "unconfirmed");
  const noHeader = await keeperhubStatus(LIVE_MODE(), "kh_e1", { fetchImpl: async () => jsonRes(200, { status: "completed" }) });
  assert.equal(noHeader.pollIntervalHint, 0);
  await assert.rejects(keeperhubStatus(LIVE_MODE(), ""), (e) => e instanceof KeeperHubError && e.code === "bad_input");
});

await t("poll: pending->unconfirmed->completed respects the hint delays; proof extracted from the terminal body", async () => {
  const seq = [
    jsonRes(200, { executionId: "kh_e2", status: "pending" }, { "x-poll-interval-hint": "2" }),
    jsonRes(200, { executionId: "kh_e2", status: "unconfirmed" }, { "x-poll-interval-hint": "1" }),
    jsonRes(200, {
      executionId: "kh_e2",
      status: "completed",
      receipts: [{ verified: true, receiptStatus: "success", transactionLink: "https://sepolia.etherscan.io/tx/0xabc" }],
    }),
  ];
  let i = 0;
  const sleeps = [];
  const poll = await pollKeeperHubExecution(LIVE_MODE(), "kh_e2", {
    fetchImpl: async () => seq[Math.min(i++, seq.length - 1)],
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(poll.terminal, true);
  assert.equal(poll.attempts, 3);
  assert.deepEqual(sleeps, [2000, 1000], "hint seconds must drive the delays");
  const proof = extractProof(poll.body);
  assert.equal(proof.verified, true);
  assert.equal(proof.transactionLink, "https://sepolia.etherscan.io/tx/0xabc");
});

await t("poll: exhausted attempts -> terminal:false (never rebroadcast), render says so", async () => {
  const poll = await pollKeeperHubExecution(LIVE_MODE(), "kh_e3", {
    fetchImpl: async () => jsonRes(200, { executionId: "kh_e3", status: "unconfirmed" }),
    sleep: async () => {},
    maxAttempts: 3,
  });
  assert.equal(poll.terminal, false);
  assert.equal(poll.attempts, 3);
  const out = renderKeeperhubTransfer({ params: PARAMS, sent: { executionId: "kh_e3" }, poll, mode: LIVE_MODE() });
  assert.match(out, /NOT terminal/);
  assert.match(out, /NEVER rebroadcast/);
  assert.match(out, /unconfirmed is NOT a failure/);
});

await t("render transfer (dry-run happy path): DRY-RUN tag + transactionLink + verified=true + receiptStatus=success", async () => {
  const mode = DRY_MODE();
  const sent = await keeperhubTransfer(mode, { ...PARAMS, simulate: false });
  const poll = await pollKeeperHubExecution(mode, sent.executionId, { fetchImpl: async () => { throw new Error("dry-run must not touch fetch"); } });
  assert.equal(poll.terminal, true);
  const out = renderKeeperhubTransfer({ params: PARAMS, sent, poll, mode });
  assert.ok(out.includes("[DRY-RUN MOCK — TODO-VERIFY live]"));
  assert.ok(out.includes("transactionLink:"));
  assert.ok(out.includes("dry-run-mock.invalid"), "mock link must be unambiguous (.invalid), never a real explorer URL");
  assert.match(out, /verified=true/);
  assert.match(out, /receiptStatus="success"/);
  assert.ok(out.includes("tx-link"));
});

await t("render simulate + status + param line: tagged, no JSON dump, honest next steps", async () => {
  const mode = DRY_MODE();
  const sim = await keeperhubTransfer(mode, { ...PARAMS, simulate: true });
  const simOut = renderKeeperhubSimulate({ params: PARAMS, result: sim, mode });
  assert.ok(simOut.includes("[DRY-RUN MOCK — TODO-VERIFY live]"));
  assert.match(simOut, /success=true wouldRevert=false/);
  assert.match(simOut, /nothing broadcast/);
  const st = await keeperhubStatus(mode, "kh_dryrun_x");
  const stOut = renderKeeperhubStatus({ executionId: "kh_dryrun_x", result: st, mode });
  assert.match(stOut, /status: "completed"/);
  assert.match(stOut, /pollIntervalHint: 0s/);
  assert.match(stOut, /transactionLink:/);
  assert.ok(!stOut.trimStart().startsWith("{"), "must be ASCII report, not a JSON dump");
  const line = keeperhubParamLine(PARAMS);
  assert.ok(line.includes("11155111 (Ethereum Sepolia, testnet)"));
  assert.ok(line.includes("native"));
});

await t("CLI e2e: keeperhub-tx transfer --provider dry-run exits 0 with tagged proof (exit-code path covered)", () => {
  const r = spawnSync(
    process.execPath,
    [BIN, "keeperhub-tx", "transfer", "--provider", "dry-run", "--chain-id", "11155111", "--to", PARAMS.to, "--amount", "0.0001"],
    { cwd: repoRoot, encoding: "utf8", env: ENV_NONE },
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("[DRY-RUN MOCK — TODO-VERIFY live]"));
  assert.ok(r.stdout.includes("transactionLink:"));
  assert.ok(r.stdout.includes("verified=true"));
  assert.ok(r.stdout.includes('receiptStatus="success"'));
});

await t("CLI e2e: simulate + status dry-run exit 0", () => {
  const sim = spawnSync(
    process.execPath,
    [BIN, "keeperhub-tx", "simulate", "--provider", "dry-run", "--chain-id", "84532", "--to", PARAMS.to, "--amount", "0.0001"],
    { cwd: repoRoot, encoding: "utf8", env: ENV_NONE },
  );
  assert.equal(sim.status, 0, `stderr: ${sim.stderr}`);
  assert.match(sim.stdout, /success=true wouldRevert=false/);
  assert.ok(sim.stdout.includes("Base Sepolia"));
  const st = spawnSync(process.execPath, [BIN, "keeperhub-tx", "status", "--provider", "dry-run", "--execution-id", "kh_dryrun_x"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: ENV_NONE,
  });
  assert.equal(st.status, 0, `stderr: ${st.stderr}`);
  assert.ok(st.stdout.includes("DRY-RUN MOCK"));
  assert.ok(st.stdout.includes("transactionLink:"));
});

await t("CLI e2e: no KEEPERHUB_KEY -> exit 2 with typed missing_api_key (fail closed)", () => {
  const r = spawnSync(
    process.execPath,
    [BIN, "keeperhub-tx", "transfer", "--chain-id", "11155111", "--to", PARAMS.to, "--amount", "0.0001"],
    { cwd: repoRoot, encoding: "utf8", env: ENV_NONE },
  );
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("error[missing_api_key]"));
  assert.ok(r.stderr.includes("--provider dry-run"));
});

await t("CLI e2e: bad params -> exit 2 error[bad_input] with hints", () => {
  const noTo = spawnSync(process.execPath, [BIN, "keeperhub-tx", "transfer", "--provider", "dry-run", "--chain-id", "11155111", "--amount", "0.0001"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: ENV_NONE,
  });
  assert.equal(noTo.status, 2);
  assert.ok(noTo.stderr.includes("error[bad_input]"));
  const badSub = spawnSync(process.execPath, [BIN, "keeperhub-tx", "frobnicate", "--provider", "dry-run"], { cwd: repoRoot, encoding: "utf8", env: ENV_NONE });
  assert.equal(badSub.status, 2);
  assert.ok(badSub.stderr.includes("simulate | transfer | status"));
});

console.log(`\nkeeperhub-smoke: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

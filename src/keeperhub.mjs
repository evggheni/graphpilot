// KeeperHub execution client — the value-rail beside GraphPilot's Graph data-rail.
// Implements the DoraHacks "The Agent Economy" integration requirement (INTEGRATION-SPEC.md,
// dist/keeperhub-submission/): route a value movement through the KeeperHub Direct Execution
// REST layer and surface the onchain proof — transactionLink + receipts[].verified:true +
// receiptStatus:"success" (docs.keeperhub.com/api/direct-execution + guides/first-verified-transaction).
// Same house rules as src/client.mjs: zero-dep fetch, secrets env-only (KEEPERHUB_KEY /
// KEEPERHUB_API), fail closed without a key, dry-run always tagged as mock.

import { createHash } from "node:crypto";

export class KeeperHubError extends Error {
  constructor({ code, message, hint, status, executionId }) {
    super(message);
    this.name = "KeeperHubError";
    this.code = code;
    this.hint = hint ?? "";
    this.status = status ?? null;
    this.executionId = executionId ?? null;
  }
}

// TODO-VERIFY: the docs give the endpoint paths (/api/execute/*) but the spec does not pin the
// production base URL verbatim — api.keeperhub.com is the interface agreement; override with KEEPERHUB_API.
export const DEFAULT_KEEPERHUB_API = "https://api.keeperhub.com";

export const DRY_RUN_TAG = "[DRY-RUN MOCK — TODO-VERIFY live]";

const HINTS = {
  http_401: "KEEPERHUB_KEY missing/invalid — create an org key kh_… in app.keeperhub.com → Settings → Developer → API keys (INTEGRATION-SPEC §1.2)",
  http_403: "key lacks the scope: broadcast needs mcp:write (mcp:read is enough for simulate/dry-run)",
  http_422: "wallet not configured in the org (WALLET_NOT_CONFIGURED) — the Turnkey wallet is created at signup; check app.keeperhub.com → Wallet",
  http_429: "rate limited (direct execution: 60 req/min per key) — back off; do NOT rebroadcast with a fresh Idempotency-Key",
  http_400: "request rejected — read the simulate diagnostics in the message and fix the transfer params (funds/allowance/caps)",
  network: "check KEEPERHUB_API and connectivity",
  timeout: "raise --timeout-ms or check connectivity",
  bad_input: "fix the transfer params (chain-id / to / amount / token)",
  simulate_reverted: "fix the transfer params before broadcasting — simulation says the tx would fail/revert",
};

// Terminal execution states; "unconfirmed"/"pending" are NOT failures (guide §1.2.8) —
// they are re-polled and never rebroadcast. Full closed list is not in the spec — TODO-VERIFY.
const TERMINAL_STATUSES = new Set(["completed", "failed", "reverted", "expired", "cancelled"]);

export function keeperhubExecutionTerminal(status) {
  return TERMINAL_STATUSES.has(String(status ?? "").toLowerCase());
}

// Secrets env-only (config.json never carries a KEEPERHUB key — same rule as GRAPH_STUDIO_KEY).
export function loadKeeperHubConfig({ env = process.env } = {}) {
  return {
    apiKey: env.KEEPERHUB_KEY ?? "",
    apiBase: (env.KEEPERHUB_API ?? "").trim().replace(/\/+$/, "") || DEFAULT_KEEPERHUB_API,
    provider: env.KEEPERHUB_PROVIDER ?? "",
  };
}

// Mode selection, first match wins (mirrors resolveProvider in src/config.mjs):
//   1. explicit provider=dry-run -> labeled offline mock (TODO-VERIFY live)
//   2. KEEPERHUB_KEY (org kh_ key) -> live Direct Execution REST, Bearer auth
//   3. nothing -> typed missing_api_key (fail closed, never silent mocks)
export function resolveKeeperHubMode(cfg = {}, flags = {}) {
  const provider = flags.provider ?? cfg.provider ?? "";
  if (provider === "dry-run") {
    return { kind: "dry-run", dryRun: true, apiBase: null, headers: {}, label: "keeperhub dry-run (labeled mock — TODO-VERIFY live)" };
  }
  if (!cfg.apiKey) {
    throw new KeeperHubError({
      code: "missing_api_key",
      message: "no KeeperHub API key configured (need KEEPERHUB_KEY org key kh_…; scope mcp:write for broadcast, mcp:read for simulate)",
      hint: "export KEEPERHUB_KEY=kh_…  # app.keeperhub.com → Settings → Developer — or run with --provider dry-run (labeled mock, offline)",
    });
  }
  return {
    kind: "live",
    dryRun: false,
    apiBase: cfg.apiBase,
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    label: `keeperhub live (Direct Execution REST) -> ${cfg.apiBase}`,
  };
}

// Canonical Idempotency-Key: SHA-256 over taskId|chainId|recipientAddress|amount|tokenAddress
// (guide §1.2.5). TODO-VERIFY: the docs' exact canonicalization (case/trim/decimal form) is not
// verbatim in the spec — this is the interface agreement: trim, lowercase addresses, plain
// decimal amount string. Same params => same key, so a retried broadcast cannot double-spend.
export function idempotencyKey({ taskId, chainId, to, amount, tokenAddress }) {
  const canon = [
    String(taskId ?? "").trim(),
    String(chainId).trim(),
    String(to).trim().toLowerCase(),
    String(amount).trim(),
    String(tokenAddress ?? "").trim().toLowerCase(),
  ].join("|");
  return createHash("sha256").update(canon).digest("hex");
}

const KNOWN_CHAINS = {
  11155111: { name: "Ethereum Sepolia", testnet: true },
  84532: { name: "Base Sepolia", testnet: true },
};

export function describeChain(chainId) {
  const c = KNOWN_CHAINS[Number(chainId)];
  if (c) return `${chainId} (${c.name}${c.testnet ? ", testnet" : ""})`;
  return `${chainId} (testnet/mainnet unverified — TODO-VERIFY via GET /api/chains: isEnabled && isTestnet)`;
}

export function keeperhubParamLine({ chainId, to, amount, tokenAddress }) {
  return `chain: ${describeChain(chainId)} · to: ${to} · amount: ${amount} ${tokenAddress ? `· token: ${tokenAddress}` : "· native"}`;
}

async function keeperhubRequest(url, { method, headers, body, timeoutMs, fetchImpl }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { method, headers, body, signal: ctrl.signal });
  } catch (e) {
    const aborted = e?.name === "AbortError";
    throw new KeeperHubError({
      code: aborted ? "timeout" : "network",
      message: aborted ? `request timed out after ${timeoutMs}ms` : `network error: ${e?.message ?? e}`,
      hint: HINTS[aborted ? "timeout" : "network"],
    });
  } finally {
    clearTimeout(timer);
  }
  let responseBody = null;
  if (res.status !== 204) {
    try {
      responseBody = await res.json();
    } catch {
      responseBody = null;
    }
  }
  if (!res.ok) throw keeperhubHttpError(res.status, responseBody, url);
  if (responseBody === null || typeof responseBody !== "object") {
    throw new KeeperHubError({ code: "bad_json", message: `response from ${url} is not a JSON object`, hint: "unexpected KeeperHub response — TODO-VERIFY endpoint shape" });
  }
  return { body: responseBody, headers: res.headers };
}

function keeperhubHttpError(status, body, url) {
  const apiMessage = [body?.message, body?.error, body?.code].filter(Boolean).join(" ");
  const suffix = apiMessage ? `: ${apiMessage}` : "";
  if (status === 422) {
    return new KeeperHubError({ code: "wallet_not_configured", message: `HTTP 422 from ${url}${suffix}`, hint: HINTS.http_422, status });
  }
  // 400 carries the simulate diagnostics (INTEGRATION-SPEC §2.2: "400 simulate-диагностика").
  if (status === 400) {
    return new KeeperHubError({ code: "http_400", message: `HTTP 400 from ${url}${suffix || " (simulate diagnostics empty)"}`, hint: HINTS.http_400, status });
  }
  const code = `http_${status}`;
  return new KeeperHubError({
    code,
    message: `HTTP ${status} from ${url}${suffix}`,
    hint: HINTS[code] ?? "check KEEPERHUB_API / key scope against docs.keeperhub.com/api/direct-execution — TODO-VERIFY",
    status,
  });
}

// Direct Execution transfer. simulate=true strictly boolean, never broadcasts and never returns
// a transaction hash (guide §1.2.4); simulate=false sends the canonical Idempotency-Key header
// and returns 202 Accepted { executionId, status, ... } — poll for the proof.
// TODO-VERIFY: body field naming (recipientAddress/tokenAddress) and the 202 response shape
// follow the spec's examples; never exercised against the live API yet (needs kh_ key + funds).
export async function keeperhubTransfer(mode, { chainId, to, amount, tokenAddress = "", taskId = "graphpilot", simulate = false }, { timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
  if (mode.dryRun) return mockTransfer({ chainId, to, amount, tokenAddress, simulate });
  const body = {
    chainId: Number(chainId),
    recipientAddress: String(to).trim().toLowerCase(),
    amount: String(amount).trim(),
    simulate: simulate === true,
    ...(String(tokenAddress ?? "").trim() ? { tokenAddress: String(tokenAddress).trim().toLowerCase() } : {}),
  };
  const headers = {
    "content-type": "application/json",
    ...mode.headers,
    ...(simulate ? {} : { "idempotency-key": idempotencyKey({ taskId, chainId, to, amount, tokenAddress }) }),
  };
  const res = await keeperhubRequest(`${mode.apiBase}/api/execute/transfer`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeoutMs,
    fetchImpl,
  });
  return { ...res.body, meta: { dryRun: false } };
}

// Poll one execution. Honors X-Poll-Interval-Hint (seconds; 0 = terminal — TODO-VERIFY: unit
// assumption). dry-run answers from the labeled mock without touching fetch.
export async function keeperhubStatus(mode, executionId, { timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
  if (!executionId || typeof executionId !== "string" || !executionId.trim()) {
    throw new KeeperHubError({ code: "bad_input", message: "executionId is required", hint: "pass the executionId returned by the broadcast (CLI: keeperhub-tx status --execution-id <id>)" });
  }
  const id = executionId.trim();
  if (mode.dryRun) return { body: mockStatus(id), pollIntervalHint: 0, meta: { dryRun: true } };
  const res = await keeperhubRequest(`${mode.apiBase}/api/execute/${encodeURIComponent(id)}/status`, {
    method: "GET",
    headers: { ...mode.headers },
    timeoutMs,
    fetchImpl,
  });
  const hint = Number(res.headers?.get?.("x-poll-interval-hint") ?? 0);
  return { body: res.body, pollIntervalHint: Number.isFinite(hint) && hint > 0 ? hint : 0, meta: { dryRun: false } };
}

// simulate -> terminal (or maxAttempts). Broadcast is NEVER repeated here: an unconfirmed
// execution keeps its Idempotency-Key and must only be re-polled (guide §1.2.8).
export async function pollKeeperHubExecution(mode, executionId, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  maxAttempts = 10,
  baseDelayMs = 1000,
  maxDelayMs = 10000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await keeperhubStatus(mode, executionId, { timeoutMs, fetchImpl });
    last = res;
    if (keeperhubExecutionTerminal(res.body?.status)) return { ...res, attempts: attempt, terminal: true };
    if (attempt < maxAttempts) {
      const delay = mode.dryRun ? 0 : Math.max(baseDelayMs, Math.min(maxDelayMs, (res.pollIntervalHint || baseDelayMs) * 1000));
      if (delay > 0) await sleep(delay);
    }
  }
  return { ...last, attempts: maxAttempts, terminal: false };
}

// Proof per guide §1.2.7: status "completed" + a receipts[] entry with verified:true AND
// receiptStatus:"success"; transactionLink (explorer URL) is the onchain proof. Top-level
// transactionLink/transactionHash are the fallback if receipts are shaped differently
// (TODO-VERIFY against the live API). sponsored:true may leave the tx out of EOA txlists —
// transactionLink is then the only evidence.
export function extractProof(body) {
  const status = String(body?.status ?? "").toLowerCase();
  const receipts = Array.isArray(body?.receipts) ? body.receipts : [];
  const ok = receipts.find((r) => r?.verified === true && String(r?.receiptStatus ?? "").toLowerCase() === "success");
  return {
    status,
    completed: status === "completed",
    verified: ok !== undefined,
    receiptStatus: ok ? String(ok.receiptStatus).toLowerCase() : receipts[0] ? String(receipts[0].receiptStatus ?? "").toLowerCase() : "",
    transactionLink: ok?.transactionLink ?? body?.transactionLink ?? null,
    transactionHash: ok?.transactionHash ?? body?.transactionHash ?? null,
    executionId: body?.executionId ?? body?.id ?? null,
  };
}

// --- dry-run mocks (offline/CI; every renderer tags DRY_RUN_TAG, links use .invalid) ---

const DRY_RUN_LINK_BASE = "https://dry-run-mock.invalid/tx";

function dryRunHash(seed) {
  return `0x${createHash("sha256").update(seed).digest("hex")}`;
}

function mockTransfer({ chainId, to, amount, tokenAddress, simulate }) {
  const key = idempotencyKey({ taskId: "dry-run", chainId, to, amount, tokenAddress });
  const executionId = `kh_dryrun_${key.slice(0, 16)}`;
  if (simulate) {
    // Guide §1.2.4 shape: wait for success:true, wouldRevert:false — no hash, nothing broadcast.
    return { executionId, simulate: true, status: "simulated", success: true, wouldRevert: false, meta: { dryRun: true } };
  }
  const link = `${DRY_RUN_LINK_BASE}/${dryRunHash(key)}`;
  return {
    executionId,
    status: "completed",
    transactionHash: dryRunHash(key),
    transactionLink: link,
    receipts: [{ verified: true, receiptStatus: "success", transactionHash: dryRunHash(key), transactionLink: link }],
    meta: { dryRun: true },
  };
}

function mockStatus(executionId) {
  const link = `${DRY_RUN_LINK_BASE}/${dryRunHash(executionId)}`;
  return {
    executionId,
    status: "completed",
    transactionHash: dryRunHash(executionId),
    transactionLink: link,
    receipts: [{ verified: true, receiptStatus: "success", transactionHash: dryRunHash(executionId), transactionLink: link }],
  };
}

// --- ASCII renderers (report style, no JSON dumps) ---

export function renderKeeperhubSimulate({ params, result, mode }) {
  const L = [];
  L.push(`GraphPilot keeperhub-tx simulate${mode.dryRun ? `   ${DRY_RUN_TAG}` : ""}`);
  L.push(`mode: ${mode.label}`);
  L.push(keeperhubParamLine(params));
  L.push(`simulate: success=${result?.success ?? "?"} wouldRevert=${result?.wouldRevert ?? "?"} (status "${result?.status ?? "?"}") — nothing broadcast, no tx hash by design`);
  if (mode.dryRun) {
    L.push("next: live path = KEEPERHUB_KEY (scope mcp:write) + `keeperhub-tx transfer` — TODO-VERIFY live");
  } else {
    L.push("next: broadcast with `keeperhub-tx transfer` (same params → same Idempotency-Key)");
  }
  return L.join("\n");
}

export function renderKeeperhubTransfer({ params, sent, poll, mode }) {
  const proof = extractProof(poll?.body ?? sent);
  const L = [];
  L.push(`GraphPilot keeperhub-tx transfer${mode.dryRun ? `   ${DRY_RUN_TAG}` : ""}`);
  L.push(`mode: ${mode.label}`);
  L.push(keeperhubParamLine(params));
  L.push(`broadcast: executionId ${proof.executionId ?? "?"} (202 accepted, Idempotency-Key sent)`);
  if (poll?.terminal) {
    L.push(`poll: status "${proof.status}" after ${poll.attempts} poll(s) — terminal`);
    L.push(`receipt: verified=${proof.verified} receiptStatus="${proof.receiptStatus || "?"}"`);
    if (proof.completed && proof.verified) {
      L.push(`transactionLink: ${proof.transactionLink ?? "?"}`);
      L.push("^ tx-link (onchain proof for the submission form; testnet accepted — INTEGRATION-SPEC §1.1)");
    } else {
      L.push(`transactionLink: ${proof.transactionLink ?? "(none)"}`);
      L.push("WARNING: terminal without a verified success receipt — do NOT submit this as tx-proof");
    }
  } else {
    L.push(`poll: status "${proof.status || "?"}" after ${poll?.attempts ?? 0} poll(s) — NOT terminal`);
    L.push("unconfirmed is NOT a failure: re-check with `keeperhub-tx status --execution-id <id>`; NEVER rebroadcast with a new Idempotency-Key");
  }
  return L.join("\n");
}

export function renderKeeperhubStatus({ executionId, result, mode }) {
  const proof = extractProof(result?.body ?? {});
  const L = [];
  L.push(`GraphPilot keeperhub-tx status${mode.dryRun ? `   ${DRY_RUN_TAG}` : ""}`);
  L.push(`mode: ${mode.label}`);
  L.push(`executionId: ${executionId}`);
  L.push(`status: "${proof.status || "?"}" · pollIntervalHint: ${result?.pollIntervalHint ?? 0}s (0 = terminal)`);
  L.push(`receipt: verified=${proof.verified} receiptStatus="${proof.receiptStatus || "?"}"`);
  if (proof.transactionLink) {
    L.push(`transactionLink: ${proof.transactionLink}`);
    if (proof.completed && proof.verified) {
      L.push("^ tx-link (onchain proof; testnet accepted — INTEGRATION-SPEC §1.1)");
    } else {
      L.push("WARNING: not a verified success receipt — do NOT submit this as tx-proof");
    }
  } else if (!keeperhubExecutionTerminal(proof.status)) {
    L.push("not terminal yet — poll again later; unconfirmed is NOT a failure and must never be rebroadcast");
  }
  return L.join("\n");
}

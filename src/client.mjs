import { POOLS_FIXTURES, SWAPS_FIXTURES, SCHEMA_FIELDS_FIXTURE } from "./fixtures.mjs";
import { redactUrl } from "./endpoints.mjs";

export class GraphQueryError extends Error {
  constructor({ code, message, hint, status }) {
    super(message);
    this.name = "GraphQueryError";
    this.code = code;
    this.hint = hint ?? "";
    this.status = status ?? null;
  }
}

const HINTS = {
  http_401: "check GRAPH_STUDIO_KEY is a valid Studio API key (thegraph.com/studio)",
  http_402: "gateway rejected the key/plan — check Studio key usage; x402 endpoints (#4/#5, DAY0-NOTES) are the documented backup",
  http_403: "key lacks access to this subgraph/deployment",
  http_404: "wrong subgraph/deployment id for this endpoint",
  http_429: "rate limited — back off and retry; studio deploy URLs (#6) are rate-limited",
  timeout: "raise --timeout-ms or check connectivity",
};

// Single entry point for all GraphQL traffic. Live providers POST { query } (plus
// optional { variables } — used by the MCP run_graphql tool) to the resolved endpoint
// (GraphQL-over-HTTP POST, standard shape); the dry-run provider routes the query text
// to labeled mock fixtures so CI never touches the network.
export async function runQuery(provider, query, { timeoutMs = 15000, variables, fetchImpl = globalThis.fetch } = {}) {
  if (provider?.kind === "dry-run") {
    return { data: mockData(query), meta: { dryRun: true } };
  }
  if (!provider?.url) {
    throw new GraphQueryError({ code: "provider_invalid", message: "provider has no endpoint URL", hint: "re-run provider selection (resolveProvider)" });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(provider.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...provider.headers },
      body: JSON.stringify(variables === undefined ? { query } : { query, variables }),
      signal: ctrl.signal,
    });
  } catch (e) {
    const aborted = e?.name === "AbortError";
    throw new GraphQueryError({
      code: aborted ? "timeout" : "network",
      message: aborted ? `request timed out after ${timeoutMs}ms` : `network error: ${e?.message ?? e}`,
      hint: HINTS[aborted ? "timeout" : "network"] ?? "check network and endpoint URL (DAY0-NOTES matrix)",
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const code = `http_${res.status}`;
    throw new GraphQueryError({
      code,
      message: `HTTP ${res.status} from ${redactUrl(provider.url)}`,
      hint: HINTS[code] ?? "check endpoint + auth against the DAY0-NOTES matrix",
      status: res.status,
    });
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new GraphQueryError({ code: "bad_json", message: `response from ${redactUrl(provider.url)} is not JSON`, hint: "unexpected provider response — TODO-VERIFY endpoint shape" });
  }
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    throw new GraphQueryError({
      code: "graphql_errors",
      message: body.errors.map((e) => e?.message ?? String(e)).join("; "),
      hint: "check field names against the deployment schema (graphpilot discover)",
    });
  }
  if (!body || !("data" in body)) {
    throw new GraphQueryError({ code: "bad_response", message: `response from ${redactUrl(provider.url)} has no data field`, hint: "unexpected provider response — TODO-VERIFY" });
  }
  return { data: body.data, meta: { dryRun: false, url: redactUrl(provider.url) } };
}

function mockData(query) {
  const first = Number(query.match(/\bfirst:\s*(\d+)/)?.[1] ?? 5);
  const skip = Number(query.match(/\bskip:\s*(\d+)/)?.[1] ?? 0);
  if (query.includes("__schema")) {
    return { __schema: { queryType: { fields: SCHEMA_FIELDS_FIXTURE.map((name) => ({ name })) } } };
  }
  if (query.includes("pools(")) {
    return { pools: POOLS_FIXTURES.slice(skip, skip + first) };
  }
  if (query.includes("swaps(")) {
    return { swaps: SWAPS_FIXTURES.slice(skip, skip + first) };
  }
  throw new GraphQueryError({ code: "mock_unmatched", message: "dry-run provider has no fixture for this query", hint: "add a fixture in src/fixtures.mjs" });
}

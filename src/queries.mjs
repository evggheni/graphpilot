// The 3 ship queries — GraphQL selections verbatim from dist/ethonline-entry/DAY0-NOTES.md
// ("3 demo queries to ship"). Only first/skip are parameterized (standard GraphQL
// connection args) to drive --page/--limit; field selections stay as written in DAY0-NOTES.

export function poolsQuery({ first = 5, skip = 0 } = {}) {
  return `{ pools(first: ${first}, skip: ${skip}, orderBy: totalValueLockedUSD, orderDirection: desc) { id token0 { symbol } token1 { symbol } totalValueLockedUSD volumeUSD } }`;
}

export function swapsQuery({ first = 5, skip = 0 } = {}) {
  return `{ swaps(first: ${first}, skip: ${skip}, orderBy: timestamp, orderDirection: desc) { timestamp amount0 amount1 amountUSD pool { token0 { symbol } token1 { symbol } } } }`;
}

// GraphQL-spec introspection (not an invented API) — proves reachability and lists root fields.
export const SCHEMA_PROBE_QUERY = "{ __schema { queryType { fields { name } } } }";

export function clampQueryArgs({ page = 1, limit = 5 } = {}) {
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const l = Math.min(100, Math.max(1, Math.floor(Number(limit) || 5)));
  return { page: p, limit: l, first: l, skip: (p - 1) * l };
}

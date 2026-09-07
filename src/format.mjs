// Compact ASCII rendering: tables, paging footer, reasoned takeaways.
// Live results are rendered exactly as returned; mock data is always
// tagged "[DRY-RUN MOCK — TODO-VERIFY live]" so it can never pass as live output.

export function fmtInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : String(v);
}

export function shortenId(id, head = 6, tail = 4) {
  const s = String(id ?? "");
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function renderTable({ headers, rows }) {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? "").length)));
  const fmtRow = (r) => r.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [fmtRow(headers), sep, ...rows.map(fmtRow)].join("\n");
}

function header(kind, { provider, target, dryRun }) {
  const L = [];
  L.push(`GraphPilot ${kind}${dryRun ? "   [DRY-RUN MOCK — TODO-VERIFY live]" : ""}`);
  L.push(`target   : ${target}`);
  L.push(`provider : ${provider.label}`);
  L.push("");
  return L;
}

function pagingFooter({ page, limit, shown }) {
  return `page ${page} · ${shown} rows (first: ${limit}, skip: ${(page - 1) * limit}) · next page: --page ${page + 1}`;
}

export function renderPoolsResult({ data, provider, subgraphId, page, limit, dryRun }) {
  const pools = Array.isArray(data?.pools) ? data.pools : [];
  const L = header("pools — DeFi liquidity snapshot", { provider, target: `${subgraphId} (Uniswap V3, docs example — DAY0-NOTES)`, dryRun });
  L.push(renderTable({
    headers: ["#", "PAIR", "TVL $", "VOL $"],
    rows: pools.map((p, i) => [
      String(i + 1),
      `${p.token0?.symbol ?? "?"}/${p.token1?.symbol ?? "?"}`,
      fmtInt(p.totalValueLockedUSD),
      fmtInt(p.volumeUSD),
    ]),
  }));
  if (pools.length > 0) {
    const tvls = pools.map((p) => Number(p.totalValueLockedUSD)).filter(Number.isFinite);
    const total = tvls.reduce((a, b) => a + b, 0);
    const top = pools[0];
    const topShare = total > 0 ? ((Number(top.totalValueLockedUSD) / total) * 100).toFixed(1) : "?";
    L.push("");
    L.push(`takeaway: top pool ${top.token0?.symbol}/${top.token1?.symbol} = ${topShare}% of TVL shown; ${pools.length} pools, $${fmtInt(total)} total.`);
  }
  L.push(pagingFooter({ page, limit, shown: pools.length }));
  return L.join("\n");
}

export function renderSwapsResult({ data, provider, subgraphId, page, limit, dryRun }) {
  const swaps = Array.isArray(data?.swaps) ? data.swaps : [];
  const L = header("swaps — recent flow / risk narrative", { provider, target: `${subgraphId} (Uniswap V3, docs example — DAY0-NOTES)`, dryRun });
  L.push(renderTable({
    headers: ["TIME UTC", "PAIR", "AMOUNT0", "AMOUNT1", "USD"],
    rows: swaps.map((s) => {
      const t0 = s.pool?.token0?.symbol ?? "?";
      const t1 = s.pool?.token1?.symbol ?? "?";
      const ts = Number(s.timestamp);
      const time = Number.isFinite(ts) ? new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ") : String(s.timestamp);
      return [time, `${t0}/${t1}`, `${s.amount0} ${t0}`, `${s.amount1} ${t1}`, fmtInt(s.amountUSD)];
    }),
  }));
  if (swaps.length > 0) {
    const usds = swaps.map((s) => Number(s.amountUSD)).filter(Number.isFinite).sort((a, b) => a - b);
    const maxUsd = usds[usds.length - 1];
    const median = usds.length % 2 ? usds[(usds.length - 1) / 2] : usds[usds.length / 2 - 1];
    const big = swaps.find((s) => Number(s.amountUSD) === maxUsd);
    const bigPair = big ? `${big.pool?.token0?.symbol}/${big.pool?.token1?.symbol}` : "?";
    L.push("");
    L.push(`takeaway: largest swap $${fmtInt(maxUsd)} on ${bigPair}; median $${fmtInt(median)} across ${swaps.length} shown — watch for outsized flow around top pools.`);
  }
  L.push(pagingFooter({ page, limit, shown: swaps.length }));
  return L.join("\n");
}

export function renderDiscoverResult({ subgraphId, provider, fields, matrix, dryRun }) {
  const L = header("discover — endpoints + provider + schema probe", { provider, target: `${subgraphId} (Uniswap V3, docs example — DAY0-NOTES)`, dryRun });
  L.push("Endpoint matrix (verbatim from DAY0-NOTES):");
  for (const e of matrix) {
    L.push(`  ${String(e.n).padStart(2)}. ${e.url}`);
    L.push(`      auth: ${e.auth}`);
  }
  L.push("");
  L.push("Schema probe (GraphQL-spec introspection):");
  L.push(`  Query fields (${fields.length}): ${fields.length ? fields.join(", ") : "(none returned)"}`);
  if (dryRun) {
    L.push("  TODO-VERIFY: probe output is mocked until the first live run (needs Studio key or Studio deploy URL).");
  }
  return L.join("\n");
}

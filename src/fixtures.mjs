// MOCK FIXTURES — clearly-labeled dry-run data, CI/offline only (DAY0-NOTES mitigation:
// "Cache fixtures for CI only ... never mock" live demo output).
// Shapes mirror the query selections in src/queries.mjs exactly (subgraphs return
// BigDecimal/BigInt as strings). Values are synthetic: ids start 0xd0..., do not
// represent real pools.

export const POOLS_FIXTURES = [
  { id: "0xd000000000000000000000000000000000000001", token0: { symbol: "WETH" }, token1: { symbol: "USDC" }, totalValueLockedUSD: "312451889.321", volumeUSD: "89421334.55" },
  { id: "0xd000000000000000000000000000000000000002", token0: { symbol: "WETH" }, token1: { symbol: "USDT" }, totalValueLockedUSD: "201338412.90", volumeUSD: "61230418.10" },
  { id: "0xd000000000000000000000000000000000000003", token0: { symbol: "WBTC" }, token1: { symbol: "WETH" }, totalValueLockedUSD: "88213904.44", volumeUSD: "21450932.87" },
  { id: "0xd000000000000000000000000000000000000004", token0: { symbol: "USDC" }, token1: { symbol: "USDT" }, totalValueLockedUSD: "41220871.05", volumeUSD: "30984412.61" },
  { id: "0xd000000000000000000000000000000000000005", token0: { symbol: "LINK" }, token1: { symbol: "WETH" }, totalValueLockedUSD: "9120412.80", volumeUSD: "1902113.40" },
  { id: "0xd000000000000000000000000000000000000006", token0: { symbol: "UNI" }, token1: { symbol: "WETH" }, totalValueLockedUSD: "7331204.17", volumeUSD: "1240998.55" },
  { id: "0xd000000000000000000000000000000000000007", token0: { symbol: "PEPE" }, token1: { symbol: "WETH" }, totalValueLockedUSD: "2104518.92", volumeUSD: "8844120.03" },
];

export const SWAPS_FIXTURES = [
  { timestamp: "1788652740", amount0: "12.5", amount1: "46875.00", amountUSD: "46875.00", pool: { token0: { symbol: "WETH" }, token1: { symbol: "USDC" } } },
  { timestamp: "1788652712", amount0: "31200.00", amount1: "9.64", amountUSD: "31200.00", pool: { token0: { symbol: "USDC" }, token1: { symbol: "WETH" } } },
  { timestamp: "1788652688", amount0: "0.82", amount1: "0.0121", amountUSD: "3072.45", pool: { token0: { symbol: "WBTC" }, token1: { symbol: "WETH" } } },
  { timestamp: "1788652650", amount0: "5400.00", amount1: "5402.11", amountUSD: "5401.05", pool: { token0: { symbol: "USDC" }, token1: { symbol: "USDT" } } },
  { timestamp: "1788652602", amount0: "14400.00", amount1: "293.10", amountUSD: "293.10", pool: { token0: { symbol: "PEPE" }, token1: { symbol: "WETH" } } },
  { timestamp: "1788652561", amount0: "88.4", amount1: "344.76", amountUSD: "344.76", pool: { token0: { symbol: "LINK" }, token1: { symbol: "WETH" } } },
  { timestamp: "1788652519", amount0: "730.00", amount1: "204.55", amountUSD: "204.55", pool: { token0: { symbol: "UNI" }, token1: { symbol: "WETH" } } },
];

export const SCHEMA_FIELDS_FIXTURE = [
  "bundles", "factories", "pools", "positions", "mints", "burns", "swaps", "ticks", "tokens", "collects", "_meta",
];

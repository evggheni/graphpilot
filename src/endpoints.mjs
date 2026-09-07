// Endpoint registry — transcribed verbatim from dist/ethonline-entry/DAY0-NOTES.md (2026-09-06).
// Do not edit URL patterns here without updating DAY0-NOTES.md and the docs it cites.

export const DEFAULT_SUBGRAPH_ID = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV"; // Uniswap V3, docs example (DAY0-NOTES)

export const ENDPOINT_MATRIX = [
  { n: 1, url: "https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>", auth: "Studio API key in path", provider: "gateway-path-key" },
  { n: 2, url: "POST https://gateway.thegraph.com/api/subgraphs/id/<SUBGRAPH_ID>", auth: "Authorization: Bearer <API_KEY>", provider: "gateway-bearer" },
  { n: 3, url: "POST https://gateway.thegraph.com/api/deployments/id/<DEPLOYMENT_ID>", auth: "Bearer Studio key", provider: "gateway-deployment" },
  { n: 4, url: "POST https://gateway.thegraph.com/api/x402/subgraphs/id/<SUBGRAPH_ID>", auth: "No API key; USDC x402 on Base (X402_PRIVATE_KEY)", provider: "x402" },
  { n: 5, url: "POST https://testnet.gateway.thegraph.com/api/x402/subgraphs/id/<SUBGRAPH_ID>", auth: "x402 on Base Sepolia", provider: "x402-testnet" },
  { n: 6, url: "https://api.studio.thegraph.com/query/<ID>/<NAME>/<VERSION>", auth: "Studio deploy URL; rate-limited; no Network key", provider: "studio-url" },
  { n: 7, url: "https://subgraphs.mcp.thegraph.com/sse", auth: "Authorization: Bearer <GATEWAY_API_KEY> (Studio)", provider: "mcp-sse" },
  { n: 8, url: "https://token-api.thegraph.com/v1/... (e.g. /evm/balances)", auth: "Bearer <JWT> from thegraph.market (free plan)", provider: "token-api" },
  { n: 9, url: "https://token-api.mcp.thegraph.com/ (npx @pinax/mcp --remote-url ...)", auth: "ACCESS_TOKEN=<JWT>", provider: "token-mcp" },
];

// Live URL builders for the providers GraphPilot implements today (#2, #3, #6).
// Endpoint #1 is a variant of #2 (key in path) and is intentionally not implemented;
// #4/#5 (x402) and #7-#9 (MCP SSE / Token API) are registry-only for now — see README TODO-VERIFY.

export function gatewayBearerUrl(subgraphId) {
  return `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`;
}

export function gatewayDeploymentUrl(deploymentId) {
  return `https://gateway.thegraph.com/api/deployments/id/${deploymentId}`;
}

// Redact an API key that was embedded in a URL path (endpoint #1 style) before printing.
export function redactUrl(url) {
  return String(url).replace(/\/api\/[^/]+\/subgraphs\//, "/api/<KEY>/subgraphs/");
}

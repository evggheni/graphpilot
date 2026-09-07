import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_SUBGRAPH_ID, gatewayBearerUrl, gatewayDeploymentUrl } from "./endpoints.mjs";

export class ConfigError extends Error {
  constructor({ code, message, hint }) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.hint = hint ?? "";
  }
}

function clampInt(v, min, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// Config precedence: env > config file > defaults. The Studio API key is read ONLY
// from env GRAPH_STUDIO_KEY (never from files, so config.json stays secret-free).
export function loadConfig({ env = process.env, configFile } = {}) {
  const file = configFile ?? env.GRAPHPILOT_CONFIG ?? (existsSync("config.json") ? "config.json" : null);
  let fileCfg = {};
  if (file) {
    if (!existsSync(file)) {
      throw new ConfigError({ code: "config_not_found", message: `config file not found: ${file}`, hint: "copy config.example.json to config.json and edit it" });
    }
    try {
      fileCfg = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new ConfigError({ code: "config_invalid", message: `config file is not valid JSON: ${file}`, hint: String(e?.message ?? e) });
    }
    if (fileCfg.apiKey) {
      throw new ConfigError({
        code: "secret_in_config",
        message: "config file contains apiKey — secrets are env-only by design",
        hint: "remove apiKey from the file and export GRAPH_STUDIO_KEY instead",
      });
    }
  }
  return {
    provider: env.GRAPHPILOT_PROVIDER ?? fileCfg.provider ?? "",
    apiKey: env.GRAPH_STUDIO_KEY ?? "",
    endpoint: env.GRAPHPILOT_ENDPOINT ?? fileCfg.endpoint ?? "",
    subgraphId: env.GRAPHPILOT_SUBGRAPH_ID ?? fileCfg.subgraphId ?? DEFAULT_SUBGRAPH_ID,
    deploymentId: env.GRAPHPILOT_DEPLOYMENT_ID ?? fileCfg.deploymentId ?? "",
    pageSize: clampInt(fileCfg.pageSize ?? 5, 1, 100),
    timeoutMs: clampInt(fileCfg.timeoutMs ?? 15000, 1000, 60000),
  };
}

// Provider selection, first match wins:
//   1. explicit provider=dry-run            -> labeled mock fixtures (offline/CI, TODO-VERIFY live)
//   2. deploymentId + apiKey                -> endpoint #3  POST /api/deployments/id/<ID>  (Bearer; pinned for video)
//   3. endpoint (Studio deploy URL)         -> endpoint #6  keyless, own Studio deployments only (TODO-VERIFY)
//   4. apiKey                               -> endpoint #2  POST /api/subgraphs/id/<ID>   (Bearer; primary live path)
//   5. nothing                              -> typed missing_api_key (fail closed, TECH-PLAN: never mock silently)
export function resolveProvider(cfg = {}, flags = {}) {
  const provider = flags.provider ?? cfg.provider ?? "";
  if (provider === "dry-run") {
    return { kind: "dry-run", dryRun: true, url: null, headers: {}, label: "dry-run (labeled mock fixtures — TODO-VERIFY live)" };
  }
  if (cfg.deploymentId && cfg.apiKey) {
    return {
      kind: "gateway-deployment",
      dryRun: false,
      url: gatewayDeploymentUrl(cfg.deploymentId),
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      label: `gateway-deployment (endpoint #3, Bearer) -> deployment ${cfg.deploymentId}`,
    };
  }
  if (cfg.endpoint) {
    return {
      kind: "studio-url",
      dryRun: false,
      url: cfg.endpoint,
      headers: {},
      label: `studio-url (endpoint #6, keyless — own Studio deployments only, TODO-VERIFY) -> ${cfg.endpoint}`,
    };
  }
  if (cfg.apiKey) {
    return {
      kind: "gateway-bearer",
      dryRun: false,
      url: gatewayBearerUrl(cfg.subgraphId),
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      label: `gateway-bearer (endpoint #2, Bearer) -> subgraph ${cfg.subgraphId}`,
    };
  }
  throw new ConfigError({
    code: "missing_api_key",
    message: "no live provider configured (need GRAPH_STUDIO_KEY, or GRAPHPILOT_ENDPOINT studio deploy URL)",
    hint: "export GRAPH_STUDIO_KEY=<Studio API key>  # thegraph.com/studio — or run with --provider dry-run (labeled mock, offline)",
  });
}

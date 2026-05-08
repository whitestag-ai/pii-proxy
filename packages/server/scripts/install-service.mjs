#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import url from "node:url";
import { dataDir, logDir } from "./lib/paths.mjs";
import { renderLaunchdPlist, renderSystemdUnit } from "./lib/service-templates.mjs";
import { info, ok, fail } from "./lib/console.mjs";

const SERVICE_NAME = "io.piiproxy.server";
const DISPLAY_NAME = "PII Proxy";
const DESCRIPTION = "GDPR-compliant anonymisation gate for LLM calls";

function parseArgs(argv) {
  const args = { dryRun: false, platform: process.platform, system: false };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--system") args.system = true;
    else if (a.startsWith("--platform=")) args.platform = a.slice("--platform=".length);
    else { fail(`Unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

function buildContext() {
  const sharedKey = process.env.PII_PROXY_SHARED_KEY;
  const mappingKey = process.env.PII_PROXY_MAPPING_KEY_BASE64;
  if (!sharedKey || sharedKey.length < 32) {
    fail("PII_PROXY_SHARED_KEY env var required (min 32 chars). Generate via: node scripts/generate-shared-key.mjs");
    process.exit(1);
  }
  if (!mappingKey) {
    fail("PII_PROXY_MAPPING_KEY_BASE64 env var required. Generate via: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
    process.exit(1);
  }
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const installDir = path.resolve(here, "..");
  const entryPoint = path.join(installDir, "dist", "index.js");
  const data = dataDir("pii-proxy");
  const logs = logDir("pii-proxy");
  const env = {
    PII_PROXY_SHARED_KEY: sharedKey,
    PII_PROXY_MAPPING_KEY_BASE64: mappingKey,
    PII_PROXY_MAPPING_DB: path.join(data, "mappings.db"),
    PII_PROXY_AUDIT_DIR: path.join(data, "audit"),
  };
  for (const optional of ["PII_PROXY_PORT", "PII_PROXY_BIND", "PII_PROXY_CLASSIFIER_URL", "PII_PROXY_CLASSIFIER_MODEL", "PII_PROXY_CLASSIFIER_TIMEOUT_MS", "PII_PROXY_TELEGRAM_BOT_TOKEN", "PII_PROXY_TELEGRAM_CHAT_ID"]) {
    if (process.env[optional]) env[optional] = process.env[optional];
  }
  return {
    serviceName: SERVICE_NAME,
    displayName: DISPLAY_NAME,
    description: DESCRIPTION,
    nodeBin: process.execPath,
    entryPoint,
    workingDir: installDir,
    env,
    stdoutLog: path.join(logs, "out.log"),
    stderrLog: path.join(logs, "err.log"),
    dataDir: data,
    logDir: logs,
  };
}

function ensureDirs(ctx) {
  fs.mkdirSync(path.join(ctx.dataDir, "audit"), { recursive: true });
  fs.mkdirSync(ctx.logDir, { recursive: true });
}

function installLaunchd(ctx, dryRun) {
  const plist = renderLaunchdPlist(ctx);
  if (dryRun) { process.stdout.write(plist); return; }
  ensureDirs(ctx);
  const target = path.join(process.env.HOME, "Library", "LaunchAgents", `${ctx.serviceName}.plist`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, plist);
  spawnSync("launchctl", ["unload", target], { stdio: "ignore" });
  const r = spawnSync("launchctl", ["load", "-w", target], { stdio: "inherit" });
  if (r.status !== 0) { fail(`launchctl load failed (exit ${r.status})`); process.exit(1); }
  ok(`Installed launchd agent: ${target}`);
  info(`Health check: curl http://localhost:4711/health`);
}

function installSystemd(ctx, dryRun, system) {
  const unit = renderSystemdUnit(ctx);
  if (dryRun) { process.stdout.write(unit); return; }
  ensureDirs(ctx);
  const unitDir = system
    ? "/etc/systemd/system"
    : path.join(process.env.HOME, ".config", "systemd", "user");
  const target = path.join(unitDir, `${ctx.serviceName}.service`);
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(target, unit);
  const sc = system ? ["sudo", "systemctl"] : ["systemctl", "--user"];
  spawnSync(sc[0], sc.slice(1).concat(["daemon-reload"]), { stdio: "inherit" });
  const r = spawnSync(sc[0], sc.slice(1).concat(["enable", "--now", ctx.serviceName]), { stdio: "inherit" });
  if (r.status !== 0) { fail(`systemctl enable failed (exit ${r.status})`); process.exit(1); }
  ok(`Installed systemd unit: ${target}`);
}

async function installWindowsService(ctx, dryRun) {
  if (dryRun) {
    const config = {
      name: ctx.serviceName,
      description: ctx.description,
      script: ctx.entryPoint,
      workingDirectory: ctx.workingDir,
      env: Object.entries(ctx.env).map(([name, value]) => ({ name, value })),
    };
    process.stdout.write(`// node-windows Service config\n${JSON.stringify(config, null, 2)}\n`);
    return;
  }
  let nodeWindows;
  try { nodeWindows = await import("node-windows"); }
  catch { fail("node-windows is not installed. Run: pnpm install --include=optional"); process.exit(1); }
  ensureDirs(ctx);
  const Service = nodeWindows.Service ?? nodeWindows.default?.Service;
  const svc = new Service({
    name: ctx.serviceName,
    description: ctx.description,
    script: ctx.entryPoint,
    workingDirectory: ctx.workingDir,
    env: Object.entries(ctx.env).map(([name, value]) => ({ name, value })),
  });
  svc.on("install", () => { ok(`Installed Windows service: ${ctx.serviceName}`); svc.start(); });
  svc.on("start", () => { ok(`Started: ${ctx.serviceName}`); info("Health check: curl http://localhost:4711/health"); });
  svc.on("error", (e) => { fail(`Service error: ${e}`); process.exit(1); });
  svc.install();
}

const args = parseArgs(process.argv);
const ctx = buildContext();

switch (args.platform) {
  case "darwin": installLaunchd(ctx, args.dryRun); break;
  case "linux": installSystemd(ctx, args.dryRun, args.system); break;
  case "win32": await installWindowsService(ctx, args.dryRun); break;
  default: fail(`Unsupported platform: ${args.platform}`); process.exit(2);
}

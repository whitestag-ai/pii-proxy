#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ok, fail, warn } from "./lib/console.mjs";

const SERVICE_NAME = "io.piiproxy.server";

function uninstallLaunchd() {
  const target = path.join(process.env.HOME, "Library", "LaunchAgents", `${SERVICE_NAME}.plist`);
  if (!fs.existsSync(target)) { warn(`Not installed: ${target}`); return; }
  spawnSync("launchctl", ["unload", target], { stdio: "ignore" });
  fs.unlinkSync(target);
  ok(`Removed launchd agent: ${target}`);
}

function uninstallSystemd(system) {
  const sc = system ? ["sudo", "systemctl"] : ["systemctl", "--user"];
  spawnSync(sc[0], sc.slice(1).concat(["disable", "--now", SERVICE_NAME]), { stdio: "inherit" });
  const unitDir = system
    ? "/etc/systemd/system"
    : path.join(process.env.HOME, ".config", "systemd", "user");
  const target = path.join(unitDir, `${SERVICE_NAME}.service`);
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
    ok(`Removed systemd unit: ${target}`);
  } else {
    warn(`Not installed: ${target}`);
  }
}

async function uninstallWindowsService() {
  let nodeWindows;
  try { nodeWindows = await import("node-windows"); }
  catch { fail("node-windows not installed"); process.exit(1); }
  const Service = nodeWindows.Service ?? nodeWindows.default?.Service;
  const svc = new Service({ name: SERVICE_NAME, script: "" });
  svc.on("uninstall", () => ok(`Uninstalled Windows service: ${SERVICE_NAME}`));
  svc.uninstall();
}

const system = process.argv.includes("--system");
switch (process.platform) {
  case "darwin": uninstallLaunchd(); break;
  case "linux": uninstallSystemd(system); break;
  case "win32": await uninstallWindowsService(); break;
  default: fail(`Unsupported platform: ${process.platform}`); process.exit(2);
}

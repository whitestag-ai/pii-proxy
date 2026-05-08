import path from "node:path";
import os from "node:os";

export function dataDir(name) {
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library", "Application Support", name);
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), name);
  const xdg = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(xdg, name);
}

export function logDir(name) {
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library", "Logs", name);
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), name, "logs");
  const xdgState = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(xdgState, name, "logs");
}

export function configDir(name) {
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library", "Application Support", name);
  if (process.platform === "win32")
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), name);
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdgConfig, name);
}

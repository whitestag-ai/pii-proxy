import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { dataDir, logDir, configDir } from "./paths.mjs";

const NAME = "paperclip-dpo";

function withPlatform(plat, fn) {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: plat });
  try { return fn(); } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
}

test("dataDir on darwin", () => {
  withPlatform("darwin", () => {
    assert.equal(dataDir(NAME), path.join(os.homedir(), "Library", "Application Support", NAME));
  });
});

test("dataDir on win32 uses LOCALAPPDATA", () => {
  const origLAD = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
  try {
    withPlatform("win32", () => {
      assert.equal(dataDir(NAME), path.join("C:\\Users\\test\\AppData\\Local", NAME));
    });
  } finally {
    if (origLAD === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = origLAD;
  }
});

test("dataDir on linux uses XDG_DATA_HOME when set", () => {
  const origXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = "/custom/xdg";
  try {
    withPlatform("linux", () => {
      assert.equal(dataDir(NAME), path.join("/custom/xdg", NAME));
    });
  } finally {
    if (origXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = origXdg;
  }
});

test("logDir on darwin uses Library/Logs", () => {
  withPlatform("darwin", () => {
    assert.equal(logDir(NAME), path.join(os.homedir(), "Library", "Logs", NAME));
  });
});

test("logDir on win32 nests logs under LOCALAPPDATA", () => {
  const origLAD = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
  try {
    withPlatform("win32", () => {
      assert.equal(logDir(NAME), path.join("C:\\Users\\test\\AppData\\Local", NAME, "logs"));
    });
  } finally {
    if (origLAD === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = origLAD;
  }
});

test("configDir on linux uses XDG_CONFIG_HOME", () => {
  const orig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/custom/cfg";
  try {
    withPlatform("linux", () => {
      assert.equal(configDir(NAME), path.join("/custom/cfg", NAME));
    });
  } finally {
    if (orig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = orig;
  }
});

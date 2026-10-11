import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { Config, loadConfig } from "../src/config/config";

export function tempDir(prefix = "teleops-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function tempDbFile(dir = tempDir()): string {
  return path.join(dir, "data", "test.db");
}

/** Minimal valid config for the pure auth/DB layers. */
export function makeConfig(security: Partial<Config["security"]> = {}): Config {
  const base = loadConfig(path.join(tempDir(), "missing.yaml"));
  base.telegram.botToken = "test-token";
  base.security = { ...base.security, ...security };
  return base;
}

/** Config loaded from a YAML file exactly like the runtime does. */
export function configFromYaml(obj: unknown): Config {
  const dir = tempDir();
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, yaml.dump(obj));
  const cfg = loadConfig(file);
  cfg.telegram.botToken = "test-token";
  return cfg;
}

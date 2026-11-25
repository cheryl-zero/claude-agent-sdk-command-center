import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// APP_DIR holds the program, the agent files, the rules and the fake records.
// HOME holds everything that changes while the program runs: handoffs, logs,
// approvals, shared context and the kill flag. Tests point HOME at a
// throwaway folder through CC_HOME.
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HOME = process.env.CC_HOME ? path.resolve(process.env.CC_HOME) : path.join(APP_DIR, "state");

export const PATHS = Object.freeze({
  agents: path.join(APP_DIR, ".claude", "agents"),
  appConfig: path.join(APP_DIR, "config", "command-center.json"),
  rules: path.join(APP_DIR, "rules", "approval-rules.json"),
  data: path.join(APP_DIR, "data"),
  sharedSeed: path.join(APP_DIR, "shared", "context.md"),
  shared: path.join(HOME, "shared", "context.md"),
  handoffsOpen: path.join(HOME, "handoffs", "open"),
  handoffsDone: path.join(HOME, "handoffs", "done"),
  approvals: path.join(HOME, "approvals"),
  logs: path.join(HOME, "logs"),
  killFlag: path.join(HOME, "KILL"),
});

export function readAppConfig() {
  return JSON.parse(fs.readFileSync(PATHS.appConfig, "utf8"));
}

// Every agent is one markdown file in .claude/agents. The config file names the
// supervisor; every other file is a specialist. Nothing about an agent lives in
// code, so a file can be swapped and the program does not change.
export function readAgents() {
  const { supervisor } = readAppConfig();
  const names = fs
    .readdirSync(PATHS.agents)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
  if (!names.includes(supervisor)) {
    throw new Error(`config names the supervisor "${supervisor}" but ${PATHS.agents}/${supervisor}.md does not exist`);
  }
  for (const name of names) {
    const text = fs.readFileSync(path.join(PATHS.agents, `${name}.md`), "utf8");
    const declared = text.match(/^name:\s*(\S+)/m)?.[1];
    if (declared !== name) {
      throw new Error(`${name}.md declares name "${declared ?? ""}" — file name and frontmatter name must match`);
    }
  }
  return { supervisor, specialists: names.filter((n) => n !== supervisor) };
}

export function loadEnvFile(file = path.join(APP_DIR, ".env")) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, i).trim()] = value;
  }
  return out;
}

// Environment for the agent process: the real environment first, then whatever
// .env adds for keys that are not already set.
export function childEnv() {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(loadEnvFile())) {
    if (process.env[key] === undefined) env[key] = value;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "adam-command-center/0.1.0";
  return env;
}

export function ensureStateDirs() {
  for (const dir of [PATHS.handoffsOpen, PATHS.handoffsDone, PATHS.approvals, PATHS.logs, path.dirname(PATHS.shared)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(PATHS.shared)) fs.copyFileSync(PATHS.sharedSeed, PATHS.shared);
}

export const isKilled = () => fs.existsSync(PATHS.killFlag);

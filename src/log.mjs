import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.mjs";

// Three append-only logs. Nothing in this file ever rewrites a line.
//   activity.jsonl  — every event, in order (runs, agents, tool calls, handoffs, approvals, kill switch)
//   decisions.jsonl — what was asked, recommended, proposed, approved and executed
//   runs.jsonl      — one summary line per agent run (status, duration, tokens per agent)
const now = () => new Date().toISOString();

export const uid = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;

function append(name, record) {
  fs.mkdirSync(PATHS.logs, { recursive: true });
  fs.appendFileSync(path.join(PATHS.logs, name), `${JSON.stringify(record)}\n`);
}

export const logActivity = (event, details = {}) => append("activity.jsonl", { id: uid("EV"), ts: now(), event, ...details });
export const logDecision = (record) => append("decisions.jsonl", { ts: now(), id: uid("DEC"), ...record });
export const logRun = (record) => append("runs.jsonl", record);

export function readLog(name) {
  const file = path.join(PATHS.logs, name);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

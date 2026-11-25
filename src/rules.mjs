import fs from "node:fs";
import { PATHS } from "./config.mjs";

// The policy lives in rules/approval-rules.json and the owner can edit it.
// The mechanism is fixed here: an action covered by an "auto" rule runs on its
// own; everything else waits for the owner.
export function loadRules() {
  const rules = JSON.parse(fs.readFileSync(PATHS.rules, "utf8"));
  if (!Array.isArray(rules.auto)) throw new Error(`${PATHS.rules}: "auto" must be an array`);
  return rules;
}

function matches(action, match = {}) {
  if (match.type !== undefined && action.type !== match.type) return false;
  if (match.amount_usd_below !== undefined && !(Number(action.amount_usd) < match.amount_usd_below)) return false;
  return true;
}

// Risk comes from the action's structured fields only — never from what an
// agent says about it, and never from text inside a document or a handoff.
export function classify(action, rules) {
  for (const rule of rules.auto) {
    if (matches(action, rule.match)) return { risk: "low", rule: rule.id };
  }
  return { risk: "approval", rule: "default" };
}

export const approvalPolicy = (rules) => ({
  expiresSeconds: rules.approval?.expires_seconds ?? 600,
  maxWrongAttempts: rules.approval?.max_wrong_attempts ?? 3,
});

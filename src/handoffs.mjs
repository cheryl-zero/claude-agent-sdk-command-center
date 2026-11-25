import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.mjs";
import { logActivity, uid } from "./log.mjs";

// A recorded handoff is one markdown file in the handoffs folder:
//
//   handoffs/open/HO-....md   status: open → claimed
//   handoffs/done/HO-....md   status: done, with the result written in
//
// Agents decide WHAT to hand off. This module guarantees the record format and
// the status transitions: only the agent a handoff is addressed to can claim
// it and complete it, and a result cannot be empty.
//
// Task, context and result are free text written by models, so each one sits
// between its own markers and the marker token is stripped from the text
// itself. A handoff cannot forge another section, whatever it contains.
const now = () => new Date().toISOString();
const META_KEYS = ["id", "from", "to", "title", "status", "created_at", "claimed_at", "completed_at"];

const oneLine = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const clean = (value) => String(value ?? "").replace(/<!---/g, "<!--").trim();
const wrap = (name, value) => `<!--- ${name} --->\n${value}\n<!--- /${name} --->`;

function render(rec) {
  const meta = META_KEYS.map((k) => `${k}: ${rec[k] ?? "null"}`).join("\n");
  const { task, context, result } = rec.body;
  return [
    "---",
    meta,
    "---",
    `# Handoff ${rec.id}: ${rec.title}`,
    "",
    `From: ${rec.from} · To: ${rec.to} · Status: ${rec.status}`,
    "",
    "## Task",
    wrap("task", task),
    "",
    "## Context",
    wrap("context", context || "_none_"),
    "",
    "## Result",
    wrap("result", result || "_pending_"),
    "",
  ].join("\n");
}

function parse(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("handoff file is not in frontmatter format");
  const rec = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) rec[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const key of ["claimed_at", "completed_at"]) if (rec[key] === "null") rec[key] = null;
  rec.body = {};
  for (const name of ["task", "context", "result"]) {
    const found = m[2].match(new RegExp(`<!--- ${name} --->\\n([\\s\\S]*?)\\n<!--- /${name} --->`));
    rec.body[name] = found ? found[1] : "";
  }
  return rec;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

function loadFrom(dir, id) {
  const file = path.join(dir, `${id}.md`);
  if (!fs.existsSync(file)) return null;
  return { file, rec: parse(fs.readFileSync(file, "utf8")) };
}

const save = (file, rec) => writeAtomic(file, render(rec));

export function createHandoff({ from, to, title, task, context = "", specialists, run = null }) {
  if (!specialists.includes(to)) {
    throw new Error(`"${to}" is not a specialist. Known specialists: ${specialists.join(", ")}`);
  }
  if (!clean(task)) throw new Error("task must not be empty");
  const rec = {
    id: uid("HO"),
    from,
    to,
    title: oneLine(title, 120) || oneLine(task, 120),
    status: "open",
    created_at: now(),
    claimed_at: null,
    completed_at: null,
    body: { task: clean(task), context: clean(context), result: "" },
  };
  save(path.join(PATHS.handoffsOpen, `${rec.id}.md`), rec);
  logActivity("handoff_created", { handoff: rec.id, from, to, title: rec.title, run });
  return rec;
}

export function listHandoffs({ status, to } = {}) {
  const all = [PATHS.handoffsOpen, PATHS.handoffsDone].flatMap((dir) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".md"))
          .sort()
          .map((f) => parse(fs.readFileSync(path.join(dir, f), "utf8")))
      : [],
  );
  return all
    .filter((h) => (!status || h.status === status) && (!to || h.to === to))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function claimHandoff({ id, by }) {
  const found = loadFrom(PATHS.handoffsOpen, id);
  if (!found) return { ok: false, reason: "not_found_or_not_open" };
  if (found.rec.to !== by) {
    logActivity("handoff_claim_refused", { handoff: id, agent: by, reason: "addressed_to_another_agent" });
    return { ok: false, reason: "addressed_to_another_agent" };
  }
  if (found.rec.status !== "open") return { ok: false, reason: `status_is_${found.rec.status}` };
  found.rec.status = "claimed";
  found.rec.claimed_at = now();
  save(found.file, found.rec);
  logActivity("handoff_claimed", { handoff: id, agent: by });
  return { ok: true, handoff: found.rec };
}

export function completeHandoff({ id, by, result }) {
  const found = loadFrom(PATHS.handoffsOpen, id);
  if (!found) return { ok: false, reason: "not_found_or_not_open" };
  if (found.rec.to !== by) return { ok: false, reason: "addressed_to_another_agent" };
  if (found.rec.status !== "claimed") return { ok: false, reason: `status_is_${found.rec.status}` };
  if (!clean(result)) return { ok: false, reason: "result_must_not_be_empty" };
  found.rec.status = "done";
  found.rec.completed_at = now();
  found.rec.body.result = clean(result);
  writeAtomic(path.join(PATHS.handoffsDone, `${id}.md`), render(found.rec));
  fs.unlinkSync(found.file);
  logActivity("handoff_completed", { handoff: id, agent: by });
  return { ok: true, handoff: found.rec };
}

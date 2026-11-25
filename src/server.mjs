import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { APP_DIR, PATHS, ensureStateDirs, isKilled, readAgents } from "./config.mjs";
import * as core from "./core.mjs";
import { displayCode, listApprovals, publicApproval } from "./approvals.mjs";
import { listHandoffs } from "./handoffs.mjs";
import { readLog } from "./log.mjs";

// The web command center: one page for the owner with text and voice input,
// the four panels (agents, open handoffs, pending approvals, recent decisions),
// an activity stream and the kill switch. It calls the same functions as the
// CLI. It has no login and binds to this computer only.
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";
const INDEX = path.join(APP_DIR, "public", "index.html");
const ACTIVITY = path.join(PATHS.logs, "activity.jsonl");

let current = null; // the run in progress: { label, controller }

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("Request is too large."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function state() {
  const { supervisor, specialists } = readAgents();
  const activity = readLog("activity.jsonl");
  const counts = {};
  for (const e of activity) {
    if (!e.agent) continue;
    const c = (counts[e.agent] ??= { started: 0, finished: 0 });
    if (e.event === "run_started" || e.event === "agent_started") c.started += 1;
    if (e.event === "run_finished" || e.event === "agent_finished") c.finished += 1;
  }
  const totals = core.status();
  return {
    killed: isKilled(),
    busy: current?.label ?? null,
    agents: [supervisor, ...specialists].map((name) => ({
      name,
      role: name === supervisor ? "supervisor" : "specialist",
      running: (counts[name]?.started ?? 0) > (counts[name]?.finished ?? 0),
      tokens: totals.per_agent[name]?.tokens ?? 0,
    })),
    // The page is the owner's channel, so the one-time codes are included here.
    pending: listApprovals({ status: "pending" }).map((a) => ({ ...publicApproval(a), code: displayCode(a.code) })),
    handoffs: listHandoffs()
      .slice(-30)
      .reverse()
      .map((h) => ({ id: h.id, from: h.from, to: h.to, title: h.title, status: h.status, created_at: h.created_at })),
    decisions: readLog("decisions.jsonl").slice(-40).reverse(),
    activity: activity.slice(-80).reverse(),
    totals: { runs: totals.runs.total, executed: totals.executed },
  };
}

// ── Live events: the activity log tailed and pushed to every open page ──
// Starts at the end of the log, so a restart never replays old events as new.
const clients = new Set();
let offset = null;
let carry = "";

function push(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

setInterval(() => {
  if (!fs.existsSync(ACTIVITY)) return;
  const size = fs.statSync(ACTIVITY).size;
  if (offset === null || size < offset) {
    offset = size;
    carry = "";
    return;
  }
  if (size === offset) return;
  const chunk = carry + fs.readFileSync(ACTIVITY).subarray(offset, size).toString("utf8");
  offset = size;
  const lines = chunk.split("\n");
  carry = lines.pop();
  for (const line of lines) {
    if (!line.trim() || !clients.size) continue;
    try {
      push("activity", JSON.parse(line));
    } catch {
      // a half-written line is completed on the next tick
    }
  }
}, 250).unref();

function startRun(kind, label, task) {
  if (current) return false;
  const controller = new AbortController();
  current = { label, controller };
  task(controller.signal)
    .then((r) => {
      if (kind === "ask") {
        push("run", {
          kind,
          status: r.status,
          text: r.text,
          handoffs: r.handoffs.map((h) => ({ id: h.id, to: h.to, title: h.title })),
        });
      } else {
        push("run", {
          kind,
          status: r.status,
          results: (r.results ?? []).map((x) => ({ agent: x.agent, status: x.run.status, text: x.run.text, open_after: x.open_after })),
        });
      }
    })
    .catch((err) => push("run", { kind, status: "error", text: String(err?.message ?? err) }))
    .finally(() => {
      current = null;
      push("state", {});
    });
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = fs.readFileSync(INDEX);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }
    if (req.method === "GET" && url.pathname === "/voice.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return res.end(fs.readFileSync(path.join(APP_DIR, "public", "voice.js")));
    }
    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, state());
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      clients.add(res);
      const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15000);
      req.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return undefined;
    }
    const handoff = url.pathname.match(/^\/api\/handoff\/(HO-[A-Z0-9]+)$/);
    if (req.method === "GET" && handoff) {
      for (const dir of [PATHS.handoffsOpen, PATHS.handoffsDone]) {
        const file = path.join(dir, `${handoff[1]}.md`);
        if (fs.existsSync(file)) return send(res, 200, { content: fs.readFileSync(file, "utf8") });
      }
      return send(res, 404, { error: "not_found", message: "That handoff does not exist." });
    }

    if (req.method !== "POST") return send(res, 404, { error: "not_found", message: "Unknown address." });
    const body = await readBody(req);
    switch (url.pathname) {
      case "/api/ask": {
        const text = String(body.text ?? "").trim();
        if (!text) return send(res, 400, { error: "empty", message: "Write or say something first." });
        if (text.length > 4000) return send(res, 400, { error: "too_long", message: "Keep it under 4,000 characters." });
        ensureStateDirs();
        const started = startRun("ask", "Adam is working", (signal) => core.ask(text, { signal }));
        return started ? send(res, 202, { started: true }) : send(res, 409, { error: "busy", message: "A run is in progress. Stop it or wait for it to finish." });
      }
      case "/api/pickup": {
        ensureStateDirs();
        const agent = body.agent ? String(body.agent) : undefined;
        const started = startRun("pickup", "Specialists are picking up handoffs", (signal) => core.pickup(agent, { signal }));
        return started ? send(res, 202, { started: true }) : send(res, 409, { error: "busy", message: "A run is in progress. Stop it or wait for it to finish." });
      }
      case "/api/stop": {
        if (!current?.controller) return send(res, 409, { error: "idle", message: "No run is in progress." });
        current.controller.abort();
        return send(res, 202, { started: false });
      }
      // A refusal (wrong code, already decided) is an answer, not a failure.
      case "/api/approve":
        return send(res, 200, core.approve({ id: String(body.id ?? ""), code: String(body.code ?? "") }));
      case "/api/reject":
        return send(res, 200, core.reject({ id: String(body.id ?? "") }));
      case "/api/kill": {
        const r = core.kill();
        return send(res, 200, { cancelled: r.cancelled.length });
      }
      case "/api/reset": {
        core.reset();
        return send(res, 200, {});
      }
      default:
        return send(res, 404, { error: "not_found", message: "Unknown address." });
    }
  } catch (err) {
    return send(res, 500, { error: "server_error", message: String(err?.message ?? err) });
  }
});

ensureStateDirs();
server.listen(PORT, HOST, () => {
  console.log(`Command center: http://${HOST}:${server.address().port}`);
});

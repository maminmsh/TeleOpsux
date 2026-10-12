/**
 * Live Session Terminal Mini App — automated acceptance tests.
 *
 * Runs the REAL MiniAppServer over HTTP (ephemeral port), the real auth
 * layer, real SessionManager/Tmux/OutputHub/TerminalService, with a fake
 * ExecRunner standing in for tmux (no processes spawned) and HMAC-signed
 * initData built from the "test-token" bot token — exactly what Telegram
 * would send. Client-sent ids are exercised as untrusted selectors.
 *
 * NOT covered here (needs real services, declared honestly): opening the
 * Mini App inside the real Telegram client and browser-side rendering.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import path from "node:path";
import { DB } from "../src/db/database";
import { EventBus } from "../src/core/event-bus";
import { LogHub } from "../src/logger/logger";
import { Tmux } from "../src/session/tmux";
import { AdapterRegistry } from "../src/adapters/registry";
import { SessionManager } from "../src/session/session-manager";
import { SecretBox } from "../src/shared/secret-box";
import { CredentialService } from "../src/credentials/credential-service";
import { TelegramController } from "../src/telegram/bot";
import { OutputHub } from "../src/web/output-hub";
import { TerminalService } from "../src/web/terminal-service";
import { MiniAppServer } from "../src/web/mini-app-server";
import { validateInitData } from "../src/web/telegram-init-data";
import { redactSecrets, DENY_MESSAGE } from "../src/auth/access";
import type { ExecRunner, ExecResult } from "../src/exec/exec-runner";
import type { App } from "../src/core/container";
import { makeConfig, tempDir } from "./helpers";

const ADMIN = 100;
const USER_A = 111;
const USER_B = 222;
const BOT_TOKEN = "test-token";

// ---------- initData signing (what Telegram's client does) ----------
function signInitData(
  uid: number,
  opts: { authDate?: number; token?: string; corrupt?: boolean } = {},
): string {
  const pairs: [string, string][] = [
    ["auth_date", String(opts.authDate ?? Math.floor(Date.now() / 1000))],
    ["query_id", "QQQQ"],
    ["user", JSON.stringify({ id: uid, first_name: "U", language_code: "en" })],
  ];
  const check = [...pairs]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", opts.token ?? BOT_TOKEN)
    .update("WebAppData")
    .digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  const body = pairs
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return opts.corrupt ? `${body}&hash=deadbeef` : `${body}&hash=${hash}`;
}

// ---------- fake tmux transport ----------
class FakeRunner implements ExecRunner {
  kind = "local" as const;
  argv: string[][] = [];
  names = new Set<string>();
  panes = new Map<string, string>();

  private target(args: string[]): string {
    return args[args.indexOf("-t") + 1] ?? "";
  }
  async exec(_cmd: string, args: string[]): Promise<ExecResult> {
    this.argv.push(args);
    const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
    switch (args[0]) {
      case "-V":
        return ok("tmux 3.4\n");
      case "ls":
        return ok([...this.names].join("\n") + (this.names.size ? "\n" : ""));
      case "new-session": {
        const s = args[args.indexOf("-s") + 1];
        this.names.add(s);
        this.panes.set(s, `${s}$ `);
        return ok();
      }
      case "send-keys": {
        const t = this.target(args);
        const cur = this.panes.get(t) ?? `${t}$ `;
        if (args.includes("-l")) {
          this.panes.set(t, cur + args[args.length - 1]);
        } else if (args[args.length - 1] === "Enter") {
          this.panes.set(t, cur + "\n");
        } else {
          this.panes.set(t, cur + `<${args[args.length - 1]}>`);
        }
        return ok();
      }
      case "capture-pane":
        return ok(this.panes.get(this.target(args)) ?? "");
      case "display-message":
        return ok("4321\n");
      case "kill-session": {
        const t = this.target(args);
        this.names.delete(t);
        this.panes.delete(t);
        return ok();
      }
      case "pipe-pane":
        return { code: 1, stdout: "", stderr: "unsupported" };
      default:
        return ok();
    }
  }
  async execScript(): Promise<ExecResult> {
    return { code: 0, stdout: "", stderr: "" };
  }
  /** argv rows of tmux send-keys that typed literal TEXT to a target. */
  typedTo(target: string): string[] {
    return this.argv
      .filter((a) => a[0] === "send-keys" && a.includes("-l") && a[a.indexOf("-t") + 1] === target)
      .map((a) => a[a.length - 1]);
  }
}

// ---------- harness ----------
async function buildHarness(webappUrl = "https://mini.example.com/teleops") {
  const dir = tempDir("teleops-web-");
  const config = makeConfig({
    allowed_users: [USER_A, USER_B, ADMIN],
    admin_users: [ADMIN],
  });
  config.paths.database_file = path.join(dir, "data", "t.db");
  config.paths.log_root = path.join(dir, "logs");
  config.webapp.url = webappUrl;
  config.webapp.port = 0;
  config.telegram.botToken = BOT_TOKEN;

  const db = new DB(config.paths.database_file);
  const bus = new EventBus(db);
  const logs = new LogHub(config.paths.log_root);
  const runner = new FakeRunner();
  const tmux = new Tmux(config.sessions.tmux_prefix, runner);
  const adapters = new AdapterRegistry(config.agents);
  const sessions = new SessionManager(db, bus, tmux, adapters, logs, config);
  const credentials = new CredentialService(db, new SecretBox(path.join(dir, "key")));
  sessions.setCredentials(credentials);
  const tracker = { report() {} };

  const app = {
    config,
    db,
    bus,
    logs,
    sessions,
    adapters,
    credentials,
    tracker,
    runner,
    git: { currentBranch: async () => null, isRepo: async () => false },
    projectFiles: null,
    serverMode: { connection: null },
  } as unknown as App;

  const hub = new OutputHub(
    bus,
    (t) => credentials.redactAll(redactSecrets(t)),
  );
  const terminals = new TerminalService(app, hub);
  const server = new MiniAppServer(app, hub, terminals);
  const { port } = await server.listen();

  const mk = (owner: number | null, cwd = "/srv/app") =>
    db.createSession({
      name: `s-${owner ?? "legacy"}`,
      project_id: null,
      agent_type: "shell",
      cwd,
      owner_telegram_user_id: owner,
    });

  async function close(): Promise<void> {
    terminals.shutdown();
    hub.stop();
    await server.close();
    db.close();
    logs.close();
  }
  return { app, db, bus, hub, runner, port, sessions, credentials, mk, close, config };
}

type H = Awaited<ReturnType<typeof buildHarness>>;

const url = (h: H, p: string) => `http://127.0.0.1:${h.port}${p}`;
async function req(
  h: H,
  p: string,
  uid: number | null,
  method = "GET",
  body?: unknown,
  initData?: string,
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = {};
  if (initData !== undefined) headers["x-telegram-init-data"] = initData;
  else if (uid !== null) headers["x-telegram-init-data"] = signInitData(uid);
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(url(h, p), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await r.text();
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json (page html) */
  }
  return { status: r.status, json, text };
}

// SSE consumption
async function openSSE(h: H, p: string, uid: number | null, initData?: string) {
  const ctrl = new AbortController();
  const headers: Record<string, string> = {};
  headers["x-telegram-init-data"] =
    initData ?? (uid !== null ? signInitData(uid) : "bogus");
  const res = await fetch(url(h, p), { headers, signal: ctrl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  async function next(timeoutMs = 6000): Promise<{ event: string; data: any }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = buf.indexOf("\n\n");
      if (idx >= 0) {
        const blk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of blk.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!data) continue; // heartbeat comment block
        return { event, data: JSON.parse(data) };
      }
      if (Date.now() > deadline) throw new Error("SSE timeout");
      const raced = await Promise.race([
        reader.read(),
        new Promise<"timeout">((ok) =>
          setTimeout(() => ok("timeout"), Math.max(100, deadline - Date.now())),
        ),
      ]);
      if (raced === "timeout") continue;
      const { done, value } = raced as { done?: boolean; value?: Uint8Array };
      if (done) throw new Error("SSE closed");
      buf += dec.decode(value, { stream: true });
    }
  }
  return { status: res.status, next, cancel: () => ctrl.abort() };
}

// ---------- 1. initData validation ----------
describe("initData identity", () => {
  it("accepts a correctly signed initData and extracts the uid", () => {
    const ident = validateInitData(signInitData(USER_A), BOT_TOKEN, 3600);
    assert.equal(ident?.user.id, USER_A);
  });
  it("rejects forged hash, wrong bot token and stale auth_date", () => {
    assert.equal(validateInitData(signInitData(USER_A, { corrupt: true }), BOT_TOKEN, 3600), null);
    assert.equal(validateInitData(signInitData(USER_A, { token: "other" }), BOT_TOKEN, 3600), null);
    const old = Math.floor(Date.now() / 1000) - 7200;
    assert.equal(validateInitData(signInitData(USER_A, { authDate: old }), BOT_TOKEN, 3600), null);
  });
});

// ---------- 2. transport auth ----------
describe("API authentication", () => {
  it("no / bogus / foreign-token initData → 401; unknown user → 401", async () => {
    const h = await buildHarness();
    try {
      assert.equal((await req(h, "/api/sessions", null, "GET", undefined, "")).status, 401);
      assert.equal((await req(h, "/api/sessions", null, "GET", undefined, "user=1&hash=zz")).status, 401);
      const stranger = signInitData(999999); // signed correctly, not an allowed user
      assert.equal((await req(h, "/api/sessions", null, "GET", undefined, stranger)).status, 401);
    } finally {
      await h.close();
    }
  });

  it("raw initData never appears in the page HTML or API responses", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A);
      const page = await fetch(url(h, "/"), { signal: AbortSignal.timeout(5000) });
      const html = await page.text();
      assert.ok(!html.includes("hash=")); // auth data is header-only
      const r = await req(h, `/api/session?id=${s.id}`, USER_A);
      assert.ok(!r.text.includes("hash="));
    } finally {
      await h.close();
    }
  });
});

// ---------- 3. listing shows only permitted data ----------
describe("sessions list scoping", () => {
  it("owner sees own sessions only; admin sees all incl. legacy", async () => {
    const h = await buildHarness();
    try {
      const a = h.mk(USER_A, "/srv/a");
      const b = h.mk(USER_B);
      const legacy = h.mk(null);
      const rA = await req(h, "/api/sessions", USER_A);
      const idsA = rA.json.sessions.map((x: any) => x.id);
      assert.deepEqual(idsA, [a.id]);
      assert.ok(!rA.text.includes(`"s-legacy"`));
      const rAdm = await req(h, "/api/sessions", ADMIN);
      const idsAdm = rAdm.json.sessions.map((x: any) => x.id);
      assert.ok(idsAdm.includes(a.id) && idsAdm.includes(b.id) && idsAdm.includes(legacy.id));
      // names/status/project fields present for readable rows
      const row = rA.json.sessions[0];
      assert.ok(row.name && row.status && row.agent && "updated_at" in row);
    } finally {
      await h.close();
    }
  });
});

// ---------- 4. changing ids grants nothing ----------
describe("id-guessing is not authorization", () => {
  it("B on A's session: detail, input, events, stop, terminal all get the SAME generic deny", async () => {
    const h = await buildHarness();
    try {
      const a = h.mk(USER_A);
      const b = h.mk(USER_B);
      const probes: [string, string, unknown?][] = [
        ["GET", `/api/session?id=${a.id}`],
        ["GET", `/api/session/events?id=${a.id}&after=0`],
        ["POST", `/api/session/input?id=${a.id}`, { text: "hi" }],
        ["POST", `/api/session/stop?id=${a.id}`],
        ["POST", `/api/terminal/start?id=${a.id}`],
        ["POST", `/api/terminal/input?id=${a.id}`, { text: "id" }],
        ["GET", `/api/session?id=${b.id + 99999}`], // unknown id
      ];
      for (const [method, p, body] of probes) {
        const r = await req(h, p, USER_B, method, body);
        assert.ok(r.status === 403 || r.status === 400, `${p} must refuse, got ${r.status}`);
        assert.ok(r.text.includes(DENY_MESSAGE), `${p} → generic deny`);
      }
      // nothing touched A's resources
      assert.equal(h.runner.argv.length, 0);
    } finally {
      await h.close();
    }
  });
});

// ---------- 5/6/7. output correctness ----------
describe("output stream", () => {
  it("last 50 lines, correct chronological order", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A);
      for (let i = 1; i <= 60; i++) h.hub.append(s.id, "agent", `line ${i}`);
      const r = await req(h, `/api/session?id=${s.id}`, USER_A);
      const lines = r.json.lines;
      assert.equal(lines.length, 50);
      assert.equal(lines[0].text, "line 11");
      assert.equal(lines[49].text, "line 60");
      assert.ok(lines.every((l: any, i: number) => i === 0 || l.seq > lines[i - 1].seq));
    } finally {
      await h.close();
    }
  });

  it("empty session → empty lines (page shows the placeholder); restart → last_output fallback", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A);
      const empty = await req(h, `/api/session?id=${s.id}`, USER_A);
      assert.deepEqual(empty.json.lines, []);
      const s2 = h.mk(USER_A);
      h.db.updateSession(s2.id, { last_output: "tail from before restart" });
      const seeded = await req(h, `/api/session?id=${s2.id}`, USER_A);
      assert.ok(seeded.json.lines.some((l: any) => l.text === "tail from before restart"));
      assert.ok(seeded.json.last_seq >= 1);
    } finally {
      await h.close();
    }
  });

  it("live chunk arrives over SSE and a foreign session's output never leaks into it", async () => {
    const h = await buildHarness();
    try {
      const a = h.mk(USER_A);
      const b = h.mk(USER_B); // same user for leak test? no: A watching own; B's must never appear
      const sse = await openSSE(h, `/api/session/events?id=${a.id}&after=0`, USER_A);
      assert.equal(sse.status, 200);
      h.bus.emit({
        type: "SESSION_OUTPUT",
        session_id: a.id,
        payload: { chunk: "agent says hello" },
      });
      h.bus.emit({
        type: "SESSION_OUTPUT",
        session_id: b.id,
        payload: { chunk: "SECRET-OTHER-SESSION" },
      });
      const e1 = await sse.next();
      assert.equal(e1.event, "line");
      assert.match(e1.data.text, /agent says hello/);
      assert.equal(e1.data.source, "agent");
      // a lifecycle event produces a system line + status event
      h.db.setStatus(a.id, "FINISHED");
      h.bus.emit({ type: "SESSION_FINISHED", session_id: a.id });
      let sawStatus = false;
      let sawSystem = false;
      for (let i = 0; i < 4 && !(sawStatus && sawSystem); i++) {
        const e = await sse.next();
        if (e.event === "status" && e.data.status === "FINISHED") sawStatus = true;
        if (e.event === "line" && e.data.source === "system") sawSystem = true;
        assert.ok(!JSON.stringify(e.data).includes("SECRET-OTHER-SESSION"), "cross-session leak");
      }
      assert.ok(sawStatus && sawSystem);
      sse.cancel();
    } finally {
      await h.close();
    }
  });

  it("reconnect replays exactly the missed lines — no duplicates, no gaps", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A);
      h.bus.emit({ type: "SESSION_OUTPUT", session_id: s.id, payload: { chunk: "one" } });
      const sse1 = await openSSE(h, `/api/session/events?id=${s.id}&after=0`, USER_A);
      const l1 = await sse1.next();
      assert.equal(l1.data.text, "one");
      const lastSeq = l1.data.seq;
      sse1.cancel(); // "network drop"
      h.bus.emit({ type: "SESSION_OUTPUT", session_id: s.id, payload: { chunk: "two" } });
      h.bus.emit({ type: "SESSION_OUTPUT", session_id: s.id, payload: { chunk: "three" } });
      const sse2 = await openSSE(h, `/api/session/events?id=${s.id}&after=${lastSeq}`, USER_A);
      const a = await sse2.next();
      const b = await sse2.next();
      assert.deepEqual([a.data.text, b.data.text], ["two", "three"]);
      assert.ok(a.data.seq > lastSeq && b.data.seq > a.data.seq);
      sse2.cancel();
    } finally {
      await h.close();
    }
  });

  it("secrets are scrubbed from everything the web client can read", async () => {
    const h = await buildHarness();
    try {
      h.credentials.save(USER_A, "QODERKEY-SUPER-SECRET-9182");
      const s = h.mk(USER_A);
      h.bus.emit({
        type: "SESSION_OUTPUT",
        session_id: s.id,
        payload: { chunk: "password=hunter2 and key QODERKEY-SUPER-SECRET-9182 used" },
      });
      const r = await req(h, `/api/session?id=${s.id}`, USER_A);
      assert.ok(!r.text.includes("hunter2"), "password leaked");
      assert.ok(!r.text.includes("QODERKEY-SUPER-SECRET-9182"), "stored token leaked");
      assert.ok(r.text.includes("password: ***"), "redaction marker expected");
    } finally {
      await h.close();
    }
  });
});

// ---------- 8. agent chat vs terminal never cross ----------
describe("two input modes", () => {
  it("Agent Chat input goes to the agent pane only; terminal input to the shell pane only", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A, "/srv/app");
      // chat mode
      const chat = await req(h, `/api/session/input?id=${s.id}`, USER_A, "POST", {
        text: "hello agent",
      });
      assert.equal(chat.status, 200);
      // real SessionManager → tmux send-keys on teleops-<id>
      assert.deepEqual(h.runner.typedTo(`teleops-${s.id}`), ["hello agent"]);
      // terminal mode
      const start = await req(h, `/api/terminal/start?id=${s.id}`, USER_A, "POST");
      assert.equal(start.status, 200);
      assert.equal(start.json.active, true);
      // dedicated shell at the session cwd, on the session's transport
      const newTerm = h.runner.argv.find(
        (a) => a[0] === "new-session" && a.includes("teleops-term-" + s.id),
      );
      assert.ok(newTerm, "term-<id> session not created");
      assert.equal(newTerm![newTerm!.indexOf("-c") + 1], "/srv/app");
      const tin = await req(h, `/api/terminal/input?id=${s.id}`, USER_A, "POST", {
        text: "ls -la",
      });
      assert.equal(tin.status, 200);
      assert.deepEqual(h.runner.typedTo(`teleops-term-${s.id}`), ["ls -la"]);
      // agent pane never received the shell command, shell never got the chat
      assert.deepEqual(h.runner.typedTo(`teleops-${s.id}`), ["hello agent"]);
      assert.ok(!h.runner.typedTo(`teleops-term-${s.id}`).includes("hello agent"));
    } finally {
      await h.close();
    }
  });

  it("terminal keeps state across commands (persistent pane, not one-shot exec)", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A);
      await req(h, `/api/terminal/start?id=${s.id}`, USER_A, "POST");
      await req(h, `/api/terminal/input?id=${s.id}`, USER_A, "POST", { text: "cd subdir" });
      await req(h, `/api/terminal/input?id=${s.id}`, USER_A, "POST", { text: "pwd" });
      // both lines were typed into the SAME tmux pane, which keeps its own cwd
      assert.deepEqual(h.runner.typedTo(`teleops-term-${s.id}`), ["cd subdir", "pwd"]);
      // exactly one shell session for this chat session
      const termNames = h.runner.argv.filter(
        (a) => a[0] === "new-session" && a.some((x) => String(x).includes("term-")),
      );
      assert.equal(termNames.length, 1);
    } finally {
      await h.close();
    }
  });

  it("Ctrl+C is sent as a real key; keys outside the allowlist are refused", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A);
      await req(h, `/api/terminal/start?id=${s.id}`, USER_A, "POST");
      const c = await req(h, `/api/terminal/key?id=${s.id}`, USER_A, "POST", { key: "C-c" });
      assert.equal(c.status, 200);
      assert.ok(
        h.runner.argv.some(
          (a) =>
            a[0] === "send-keys" &&
            a[a.indexOf("-t") + 1] === `teleops-term-${s.id}` &&
            a[a.length - 1] === "C-c",
        ),
      );
      const bad = await req(h, `/api/terminal/key?id=${s.id}`, USER_A, "POST", {
        key: "C-x; rm -rf /",
      });
      assert.equal(bad.status, 400);
    } finally {
      await h.close();
    }
  });

  it("terminal streams shell output to the terminal SSE channel (source=shell)", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A);
      await req(h, `/api/terminal/start?id=${s.id}`, USER_A, "POST");
      const sse = await openSSE(h, `/api/terminal/events?id=${s.id}&after=0`, USER_A);
      const first = await sse.next(); // initial prompt captured by the poller
      assert.equal(first.event, "line");
      assert.equal(first.data.source, "shell");
      await req(h, `/api/terminal/input?id=${s.id}`, USER_A, "POST", { text: "git status" });
      let got = "";
      for (let i = 0; i < 3 && !got.includes("git status"); i++) got += (await sse.next()).data.text;
      assert.match(got, /git status/);
      sse.cancel();
    } finally {
      await h.close();
    }
  });
});

// ---------- 9. lifecycle through existing SessionManager ----------
describe("lifecycle + creation", () => {
  it("stop and resume drive the real state machine and tmux", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A);
      h.db.setStatus(s.id, "WORKING");
      const stop = await req(h, `/api/session/stop?id=${s.id}`, USER_A, "POST");
      assert.equal(stop.status, 200);
      assert.equal(h.db.getSession(s.id)!.status, "STOPPED");
      assert.ok(h.runner.argv.some((a) => a[0] === "kill-session"));
      const resume = await req(h, `/api/session/resume?id=${s.id}`, USER_A, "POST");
      assert.equal(resume.status, 200);
      assert.ok(["STARTING", "WORKING"].includes(h.db.getSession(s.id)!.status));
    } finally {
      await h.close();
    }
  });

  it("create from the Mini App runs the full SessionManager gate; owner recorded", async () => {
    const h = await buildHarness();
    try {
      const r = await req(h, "/api/session/create", ADMIN, "POST", {
        agent: "shell",
        task: "npm test",
      });
      assert.equal(r.status, 200);
      const created = h.db.getSession(r.json.id)!;
      assert.equal(created.owner_telegram_user_id, ADMIN);
      assert.ok(created.status === "WORKING" || created.status === "STARTING");
      // non-admin without a registered project → refused (same rule as Telegram)
      const bad = await req(h, "/api/session/create", USER_B, "POST", { agent: "shell" });
      assert.equal(bad.status, 400);
      assert.match(bad.json.error, /admin-only/);
    } finally {
      await h.close();
    }
  });

  it("distinct real statuses for active / finished / stopped / crashed in the list", async () => {
    const h = await buildHarness();
    try {
      const a = h.mk(USER_A);
      const b = h.mk(ADMIN);
      const c = h.mk(ADMIN);
      const d = h.mk(ADMIN);
      h.db.setStatus(a.id, "WORKING");
      h.db.setStatus(b.id, "FINISHED");
      h.db.setStatus(c.id, "STOPPED");
      h.db.setStatus(d.id, "CRASHED");
      const r = await req(h, "/api/sessions", ADMIN);
      const byId = new Map(r.json.sessions.map((x: any) => [x.id, x.status]));
      assert.equal(byId.get(a.id), "WORKING");
      assert.equal(byId.get(b.id), "FINISHED");
      assert.equal(byId.get(c.id), "STOPPED");
      assert.equal(byId.get(d.id), "CRASHED");
      // active rows come first
      assert.equal(r.json.sessions[0].id, a.id);
    } finally {
      await h.close();
    }
  });
});

// ---------- 10. cleanup + telegram compatibility ----------
describe("resource cleanup and bot integration", () => {
  it("server.close() terminates open SSE streams (no leaked listeners)", async () => {
    const h = await buildHarness();
    const sse = await openSSE(h, `/api/session/events?id=${h.mk(USER_A).id}&after=0`, USER_A);
    await sse.next(2000).catch(() => undefined);
    const t0 = Date.now();
    await h.close(); // would hang without closeAllConnections
    assert.ok(Date.now() - t0 < 5000);
  });

  it("bot sends the Open Session Terminal web_app button after wizard creation", async () => {
    const h = await buildHarness();
    try {
      const controller = new TelegramController(h.app);
      const replies: { text: string; kb?: any }[] = [];
      const ctx: any = {
        from: { id: ADMIN },
        chat: { id: 1 },
        message: { text: "x" },
        reply: async (text: string, opts?: any) => {
          replies.push({ text, kb: opts?.reply_markup });
          return { message_id: 1 };
        },
      };
      (controller as any).st(ADMIN).wizard = { step: "task", agent: "shell" };
      await (controller as any).finishWizard(ctx, "build it");
      assert.ok(replies[0]?.text.includes("created"));
      const raw = replies[0].kb; // grammy InlineKeyboard serializes to {inline_keyboard}
      const btn = raw.inline_keyboard.flat().find((b: any) => b.web_app);
      assert.ok(btn, "web_app button missing");
      assert.match(btn.web_app.url, /session=\d+$/);
      assert.ok(btn.web_app.url.startsWith("https://mini.example.com/teleops"));
    } finally {
      await h.close();
    }
  });

  it("no webapp.url configured → no Mini App button anywhere (feature off)", async () => {
    const h = await buildHarness();
    h.app.config.webapp.url = "";
    try {
      const controller = new TelegramController(h.app);
      const replies: any[] = [];
      const ctx: any = {
        from: { id: ADMIN },
        chat: { id: 1 },
        reply: async (text: string, opts?: any) => {
          replies.push({ text, kb: opts?.reply_markup });
          return { message_id: 1 };
        },
      };
      (controller as any).st(ADMIN).wizard = { step: "task", agent: "shell" };
      await (controller as any).finishWizard(ctx, "t");
      assert.equal(replies[0].kb, undefined);
    } finally {
      await h.close();
    }
  });
});

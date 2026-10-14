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
import { OutputHub, sessionKey, terminalKey } from "../src/web/output-hub";
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
const FAKE_HOME = "/home/tester";

class FakeRunner implements ExecRunner {
  kind = "local" as const;
  argv: string[][] = [];
  /** Every execScript body + stdin seen (credential staging, mkdir/ln, rm). */
  scripts: string[] = [];
  stdinWrites: string[] = [];
  names = new Set<string>();
  panes = new Map<string, string>();
  /** Binaries `command -v` (launch preflight) cannot find. */
  missingBins = new Set<string>();
  /** Panes whose process exited: tmux name -> exit code (remain-on-exit). */
  deadPanes = new Map<string, number>();
  /** Set to make `tmux -V` fail → tmux "not available on this server". */
  noTmux = false;
  /** Fake session-host filesystem for the directory browser. */
  dirs = new Set<string>([FAKE_HOME, `${FAKE_HOME}/projects`, `${FAKE_HOME}/projects/repo`, "/home", "/etc"]);
  symlinks = new Map<string, string>([[`${FAKE_HOME}/escape`, "/etc"]]);
  dirEntries = new Map<string, string>([
    [FAKE_HOME, "projects/\nnotes.txt\n"],
    [`${FAKE_HOME}/projects`, "repo/\nsrc/\nreadme.md\n"],
  ]);

  private target(args: string[]): string {
    return args[args.indexOf("-t") + 1] ?? "";
  }
  /** Lexical `..` resolution + fake symlink hop, like a real `cd && pwd -P`. */
  private resolveDir(candidate: string): string {
    const segs: string[] = [];
    for (const seg of candidate.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") segs.pop();
      else segs.push(seg);
    }
    const norm = "/" + segs.join("/");
    return this.symlinks.get(norm) ?? norm;
  }
  async exec(cmd: string, args: string[]): Promise<ExecResult> {
    this.argv.push(args);
    const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
    const gone = (): ExecResult => ({ code: 1, stdout: "", stderr: "no session" });
    if (cmd === "sh" && args[0] === "-lc") {
      const script = args[1] ?? "";
      // transport $HOME probe (terminal + browser root)
      if (script === 'cd "$HOME" && pwd -P') return ok(`${FAKE_HOME}\n`);
      // directory-browser canonicalization: sh -lc 'cd "$1" …' teleops-browse <cand>
      if (script === 'cd "$1" 2>/dev/null && pwd -P') {
        const real = this.resolveDir(args[3] ?? "");
        return this.dirs.has(real) ? ok(`${real}\n`) : { code: 1, stdout: "", stderr: "no dir" };
      }
      // SessionManager/terminal preflight: command -v "$1" <argv0> <bin>
      const bin = args[args.length - 1]!;
      return this.missingBins.has(bin)
        ? { code: 1, stdout: "", stderr: `${bin}: not found` }
        : ok(`${bin.startsWith("/") ? bin : "/usr/local/bin/" + bin}\n`);
    }
    if (cmd === "ls") {
      // browser listing: ls -1F -- <dir>
      const dir = args[args.length - 1] ?? "";
      const listing = this.dirEntries.get(dir);
      return listing === undefined
        ? { code: 2, stdout: "", stderr: `cannot access ${dir}` }
        : ok(listing);
    }
    switch (args[0]) {
      case "-V":
        return this.noTmux
          ? { code: 127, stdout: "", stderr: "tmux: not found" }
          : ok("tmux 3.4\n");
      case "ls":
        return ok([...this.names].join("\n") + (this.names.size ? "\n" : ""));
      case "new-session": {
        const s = args[args.indexOf("-s") + 1]!;
        this.names.add(s);
        // with a pane COMMAND the process is the agent (no shell prompt);
        // without one it is the interactive terminal shell.
        const ci = args.indexOf("-c");
        const isAgent = args.length > ci + 2;
        this.panes.set(s, isAgent ? "" : `${s}$ `);
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
      case "display-message": {
        const t = this.target(args);
        if (!this.names.has(t)) return gone();
        const dead = this.deadPanes.get(t);
        return ok(dead === undefined ? "0;;4321" : `1;${dead};4321`);
      }
      case "kill-session": {
        const t = this.target(args);
        this.names.delete(t);
        this.panes.delete(t);
        this.deadPanes.delete(t);
        return ok();
      }
      case "pipe-pane":
        return { code: 1, stdout: "", stderr: "unsupported" };
      default:
        return ok();
    }
  }
  async execScript(script: string, opts?: { input?: string }): Promise<ExecResult> {
    this.scripts.push(script);
    if (opts?.input !== undefined) this.stdinWrites.push(opts.input);
    return { code: 0, stdout: "", stderr: "" };
  }
  /** Everything the host would ever see in a command LINE (never stdin). */
  visible(): string {
    return [...this.argv.map((a) => a.join(" ")), ...this.scripts].join("\n");
  }
  /** argv rows of tmux send-keys that typed literal TEXT to a target. */
  typedTo(target: string): string[] {
    return this.argv
      .filter((a) => a[0] === "send-keys" && a.includes("-l") && a[a.indexOf("-t") + 1] === target)
      .map((a) => a[a.length - 1]!);
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
  // same wiring as main.ts: deleting a session forgets its live ring — the
  // PERSONAL terminal is per-user and deliberately survives session deletion
  sessions.onDeleted((id) => {
    hub.forget(sessionKey(id));
  });
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
  return { app, db, bus, hub, runner, port, sessions, terminals, credentials, mk, close, config };
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
        ["GET", `/api/session/history?id=${a.id}`],
        ["GET", `/api/session/events?id=${a.id}&after=0`],
        ["POST", `/api/session/input?id=${a.id}`, { text: "hi" }],
        ["POST", `/api/session/stop?id=${a.id}`],
        ["POST", `/api/session/delete?id=${a.id}`],
        ["GET", `/api/session?id=${b.id + 99999}`], // unknown id
      ];
      for (const [method, p, body] of probes) {
        const r = await req(h, p, USER_B, method, body);
        assert.ok(r.status === 403 || r.status === 400, `${p} must refuse, got ${r.status}`);
        assert.ok(r.text.includes(DENY_MESSAGE), `${p} → generic deny`);
      }
      // nothing touched A's resources; the delete probe deleted nothing
      assert.equal(h.runner.argv.length, 0);
      assert.ok(h.db.getSession(a.id));
      // personal terminal endpoints take NO session id at all — an attacker
      // can only ever reach their OWN terminal, so there is nothing to guess
      const own = await req(h, "/api/terminal/start", USER_B, "POST");
      assert.equal(own.status, 200);
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
      for (let i = 1; i <= 60; i++) h.hub.append(sessionKey(s.id), "agent", `line ${i}`);
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

// ---------- 8. agent chat vs personal terminal never cross ----------
describe("two input modes", () => {
  it("Agent Chat input goes to the agent pane only; terminal input to the user's own shell pane", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A, "/srv/app");
      // input modes only accept a RUNNING agent — a CREATED session must
      // never forward chat text into an untouched shell (spec §3)
      await h.sessions.start(s.id);
      // chat mode
      const chat = await req(h, `/api/session/input?id=${s.id}`, USER_A, "POST", {
        text: "hello agent",
      });
      assert.equal(chat.status, 200);
      // real SessionManager → tmux send-keys on teleops-<id>
      assert.deepEqual(h.runner.typedTo(`teleops-${s.id}`), ["hello agent"]);
      // personal terminal mode — NO session id; a zero-session user gets in too
      const start = await req(h, "/api/terminal/start", USER_A, "POST");
      assert.equal(start.status, 200);
      assert.equal(start.json.active, true);
      assert.equal(start.json.cwd, FAKE_HOME);
      // dedicated per-user shell at the transport $HOME
      const newTerm = h.runner.argv.find(
        (a) => a[0] === "new-session" && a.includes("teleops-term-u" + USER_A),
      );
      assert.ok(newTerm, "term-u<uid> session not created");
      assert.equal(newTerm![newTerm!.indexOf("-c") + 1], FAKE_HOME);
      const tin = await req(h, "/api/terminal/input", USER_A, "POST", { text: "ls -la" });
      assert.equal(tin.status, 200);
      assert.deepEqual(h.runner.typedTo(`teleops-term-u${USER_A}`), ["ls -la"]);
      // agent pane never received the shell command, shell never got the chat
      assert.deepEqual(h.runner.typedTo(`teleops-${s.id}`), ["hello agent"]);
      assert.ok(!h.runner.typedTo(`teleops-term-u${USER_A}`).includes("hello agent"));
    } finally {
      await h.close();
    }
  });

  it("terminal keeps state across commands; a repeat open reuses the ONE persistent pane", async () => {
    const h = await buildHarness();
    try {
      await req(h, "/api/terminal/start", USER_A, "POST");
      await req(h, "/api/terminal/start", USER_A, "POST"); // browser reopened → reuse
      await req(h, "/api/terminal/input", USER_A, "POST", { text: "cd subdir" });
      await req(h, "/api/terminal/input", USER_A, "POST", { text: "pwd" });
      // both lines were typed into the SAME tmux pane, which keeps its own cwd
      assert.deepEqual(h.runner.typedTo(`teleops-term-u${USER_A}`), ["cd subdir", "pwd"]);
      const termNames = h.runner.argv.filter(
        (a) => a[0] === "new-session" && a.some((x) => String(x).includes("term-")),
      );
      assert.equal(termNames.length, 1, "exactly one shell session per user");
    } finally {
      await h.close();
    }
  });

  it("Ctrl+C is sent as a real key; keys outside the allowlist are refused with an error", async () => {
    const h = await buildHarness();
    try {
      await req(h, "/api/terminal/start", USER_A, "POST");
      const c = await req(h, "/api/terminal/key", USER_A, "POST", { key: "C-c" });
      assert.equal(c.status, 200);
      assert.ok(
        h.runner.argv.some(
          (a) =>
            a[0] === "send-keys" &&
            a[a.indexOf("-t") + 1] === `teleops-term-u${USER_A}` &&
            a[a.length - 1] === "C-c",
        ),
      );
      const bad = await req(h, "/api/terminal/key", USER_A, "POST", {
        key: "C-x; rm -rf /",
      });
      assert.equal(bad.status, 400);
      assert.match(bad.json.error, /not allowed/);
    } finally {
      await h.close();
    }
  });

  it("terminal streams shell output to the user's own SSE channel (source=shell)", async () => {
    const h = await buildHarness();
    try {
      // ZERO AI sessions — opening the Mini App goes straight to the terminal
      await req(h, "/api/terminal/start", USER_A, "POST");
      const sse = await openSSE(h, "/api/terminal/events?after=0", USER_A);
      assert.equal(sse.status, 200);
      await req(h, "/api/terminal/input", USER_A, "POST", { text: "git status" });
      let got = "";
      for (let i = 0; i < 8 && !got.includes("git status"); i++) {
        const e = await sse.next();
        assert.equal(e.event, "line");
        assert.equal(e.data.source, "shell"); // never agent/system noise here
        got += e.data.text;
      }
      assert.match(got, /git status/);
      sse.cancel();
    } finally {
      await h.close();
    }
  });
});

// ---------- 8b. `qoder` in the personal terminal: same credential path ----------
describe("terminal qoder credential path", () => {
  it("a stored PAT is exported INSIDE the pane command, staged 0600 via stdin, never in a command line", async () => {
    const h = await buildHarness();
    try {
      const secret = "QODERKEY-PAT-7788";
      h.credentials.save(USER_A, secret);
      const start = await req(h, "/api/terminal/start", USER_A, "POST");
      assert.equal(start.status, 200);
      const ns = h.runner.argv.find(
        (a) => a[0] === "new-session" && a.includes(`teleops-term-u${USER_A}`),
      );
      assert.ok(ns, "terminal pane never created");
      const paneCommand = String(ns![ns!.length - 1]!);
      // token read from the staged file inside the command (never argv) and
      // deleted at exec; preflighted qoder pinned on PATH — like a managed session
      assert.match(paneCommand, /QODER_PERSONAL_ACCESS_TOKEN="\$\(cat /);
      assert.match(paneCommand, /teleops-term-111\.key/);
      assert.match(paneCommand, /rm -f/);
      assert.match(paneCommand, /\$HOME\/\.teleops\/bin/);
      const staging = h.runner.scripts.find(
        (s) => s.includes("teleops-term-111.key") && s.includes("cat >"),
      );
      assert.ok(staging, "credential file never staged");
      assert.match(staging, /umask 077/);
      assert.match(staging, /chmod 600/);
      assert.equal(h.runner.stdinWrites.filter((k) => k === secret).length, 1);
      assert.ok(!h.runner.visible().includes(secret), "PAT leaked into a command line");
      assert.ok(
        h.runner.argv.some(
          (a) => a[0] === "-lc" && a[1] === 'command -v "$1"' && a[a.length - 1] === "qoder",
        ),
        "qoder binary was never preflighted",
      );
    } finally {
      await h.close();
    }
  });

  it("without a stored key the terminal still opens and TELLS the user how to enable qoder", async () => {
    const h = await buildHarness();
    try {
      const start = await req(h, "/api/terminal/start", USER_B, "POST");
      assert.equal(start.status, 200);
      const lines = h.hub.snapshot(terminalKey(USER_B), 50).map((l) => l.text);
      assert.ok(lines.some((t) => /\/qoderkey/.test(t)), "hint missing from system lines");
    } finally {
      await h.close();
    }
  });

  it("rings are isolated per user: A's shell output never reaches B's terminal stream", async () => {
    const h = await buildHarness();
    try {
      await req(h, "/api/terminal/start", USER_A, "POST");
      await req(h, "/api/terminal/start", USER_B, "POST");
      h.hub.append(terminalKey(USER_A), "shell", "SECRET-A-SHELL");
      h.hub.append(terminalKey(USER_B), "shell", "b-line");
      const b = h.hub.snapshot(terminalKey(USER_B), 100).map((l) => l.text);
      assert.ok(b.some((t) => t === "b-line"));
      assert.ok(!b.some((t) => t.includes("SECRET-A-SHELL")), "cross-user ring leak");
      const sse = await openSSE(h, `/api/terminal/events?after=0`, USER_B);
      const first = await sse.next();
      assert.match(first.data.text, /b-line/);
      h.hub.append(terminalKey(USER_A), "shell", "LIVE-A-SECRET");
      await assert.rejects(sse.next(1500), /SSE timeout/, "A's line leaked to B live");
      sse.cancel();
    } finally {
      await h.close();
    }
  });
});

// ---------- 8c. closing the app must NOT kill the shell ----------
describe("terminal survival", () => {
  it("session deletion and TeleOps shutdown leave the pane running; only Stop kills it", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A);
      await req(h, "/api/terminal/start", USER_A, "POST");
      const killed = () =>
        h.runner.argv.some(
          (a) => a[0] === "kill-session" && a[a.indexOf("-t") + 1] === `teleops-term-u${USER_A}`,
        );
      // deleting an AI session never takes the personal terminal with it
      const del = await req(h, `/api/session/delete?id=${s.id}`, USER_A, "POST");
      assert.equal(del.status, 200);
      // idle GC / TeleOps restart: timers cleared, shell untouched
      h.terminals.shutdown();
      assert.ok(!killed(), "personal pane must never be auto-killed");
      assert.ok(h.runner.names.has(`teleops-term-u${USER_A}`), "tmux shell still running");
      // reopening attaches to the SAME live pane (scrollback preserved)
      await req(h, "/api/terminal/start", USER_A, "POST");
      const termSessions = h.runner.argv.filter(
        (a) => a[0] === "new-session" && a.includes(`teleops-term-u${USER_A}`),
      );
      assert.equal(termSessions.length, 1, "reopen must not spawn a second shell");
      // explicit Stop is the ONLY kill path
      const stop = await req(h, "/api/terminal/stop", USER_A, "POST");
      assert.equal(stop.status, 200);
      assert.ok(killed());
    } finally {
      await h.close();
    }
  });
});

// ---------- 8d. directory browser + create-in-chosen-directory ----------
describe("directory browser and create in chosen dir", () => {
  it("lists the user's own dirs under $HOME with parent navigation", async () => {
    const h = await buildHarness();
    try {
      const root = await req(h, "/api/browse", USER_A);
      assert.equal(root.status, 200);
      assert.equal(root.json.path, FAKE_HOME);
      assert.equal(root.json.home, FAKE_HOME);
      assert.equal(root.json.parent, null);
      assert.deepEqual(root.json.dirs, ["projects"]);
      const sub = await req(h, "/api/browse?path=projects", USER_A);
      assert.equal(sub.status, 200);
      assert.equal(sub.json.path, `${FAKE_HOME}/projects`);
      assert.deepEqual(sub.json.dirs, ["repo", "src"]); // files are not listed
      assert.equal(sub.json.parent, FAKE_HOME);
    } finally {
      await h.close();
    }
  });

  it("everything outside $HOME is refused WITH an explainable error: /etc, .. escape, symlink hop", async () => {
    const h = await buildHarness();
    try {
      const seen: string[] = [];
      for (const probe of ["/etc", "projects/../../..", "escape", "nope"]) {
        const r = await req(h, `/api/browse?path=${encodeURIComponent(probe)}`, USER_A);
        assert.equal(r.status, 400, `${probe} must be refused`);
        assert.match(
          r.json.error,
          /restricted to your own home|Not a readable directory/,
          `${probe} → readable refusal`,
        );
        seen.push(r.json.error);
      }
      assert.equal(new Set(seen).size >= 2, true, "confinement AND existence errors surface");
      // a refused probe never reached the listing command
      assert.ok(!h.runner.argv.some((a) => a[0] === "-1" && a.includes("/etc")));
    } finally {
      await h.close();
    }
  });

  it("a normal user may create a session in a browsed dir (canonicalized cwd); both-at-once is an error", async () => {
    const h = await buildHarness();
    try {
      const r = await req(h, "/api/session/create", USER_B, "POST", {
        agent: "shell",
        task: "run it",
        cwd: "projects",
      });
      assert.equal(r.status, 200);
      const created = h.db.getSession(r.json.id)!;
      assert.equal(created.cwd, `${FAKE_HOME}/projects`);
      assert.equal(created.owner_telegram_user_id, USER_B);
      const both = await req(h, "/api/session/create", USER_B, "POST", {
        agent: "shell",
        project_id: 1,
        cwd: "projects",
      });
      assert.equal(both.status, 400);
      assert.match(both.json.error, /EITHER/);
      const out = await req(h, "/api/session/create", USER_B, "POST", {
        agent: "shell",
        cwd: "/etc",
      });
      assert.equal(out.status, 400);
      assert.match(out.json.error, /Not a readable directory/);
    } finally {
      await h.close();
    }
  });
});

// ---------- 8e. every failure reaches the user ----------
describe("error surface", () => {
  it("missing tmux → 400 with the real reason; wrong method → 405; input before start → clear error", async () => {
    const h = await buildHarness();
    try {
      const early = await req(h, "/api/terminal/input", USER_A, "POST", { text: "ls" });
      assert.equal(early.status, 400);
      assert.match(early.json.error, /not open/);
      const wrongMethod = await req(h, "/api/terminal/start", USER_A, "GET");
      assert.equal(wrongMethod.status, 405);
      h.runner.noTmux = true;
      const r = await req(h, "/api/terminal/start", USER_A, "POST");
      assert.equal(r.status, 400);
      assert.match(r.json.error, /tmux/);
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

// ---------- 9b. delete + stored history ----------
describe("session delete and stored history", () => {
  it("owner delete kills the agent pane, removes every stored row, and leaves the personal terminal RUNNING", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A);
      h.db.setStatus(s.id, "WORKING");
      h.db.addMessage({ session_id: s.id, direction: "USER_TO_AGENT", content: "hi" });
      h.db.createTaskLog({
        session_id: s.id, project_id: null, remote_path: "/x.log", task: null, status: "STARTED",
      });
      await req(h, "/api/terminal/start", USER_A, "POST");
      const r = await req(h, `/api/session/delete?id=${s.id}`, USER_A, "POST");
      assert.equal(r.status, 200);
      assert.equal(h.db.getSession(s.id), undefined);
      assert.equal(h.db.listTaskLogs({ session_id: s.id }).length, 0, "task_logs FK rows gone");
      assert.equal(h.db.listEvents(s.id, 10).length, 0, "event rows incl. the stop event gone");
      // real teardown ran on the AGENT pane…
      assert.ok(h.runner.argv.some(
        (a) => a[0] === "kill-session" && a[a.indexOf("-t") + 1] === `teleops-${s.id}`));
      // …but the personal terminal is session-INDEPENDENT — it survives
      assert.ok(h.runner.names.has(`teleops-term-u${USER_A}`), "shell pane must stay alive");
      assert.ok(!h.runner.argv.some(
        (a) => a[0] === "kill-session" && a[a.indexOf("-t") + 1] === `teleops-term-u${USER_A}`),
        "deleting a session must never kill the personal terminal");
      assert.equal(h.terminals.status(USER_A).active, true);
      const list = await req(h, "/api/sessions", USER_A);
      assert.deepEqual(list.json.sessions.map((x: any) => x.id), []);
      const det = await req(h, `/api/session?id=${s.id}`, USER_A);
      assert.equal(det.status, 403);
    } finally {
      await h.close();
    }
  });

  it("deleting a stopped session without a terminal still works (idempotent teardown)", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A); // status CREATED — stop() transitions are skipped
      const r = await req(h, `/api/session/delete?id=${s.id}`, USER_A, "POST");
      assert.equal(r.status, 200);
      assert.equal(h.db.getSession(s.id), undefined);
    } finally {
      await h.close();
    }
  });

  it("history: last 50 stored lines in chronological order, secrets scrubbed", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A);
      for (let i = 1; i <= 60; i++)
        h.bus.emit({ type: "SESSION_OUTPUT", session_id: s.id, payload: { chunk: `line ${i}` } });
      h.db.setStatus(s.id, "FINISHED");
      h.bus.emit({ type: "SESSION_FINISHED", session_id: s.id });
      const r = await req(h, `/api/session/history?id=${s.id}`, USER_A);
      assert.equal(r.status, 200);
      const lines = r.json.lines;
      assert.equal(lines.length, 50);
      assert.equal(lines[0].text, "line 12");
      assert.equal(lines[48].text, "line 60");
      assert.equal(lines[49].source, "system");
      assert.equal(lines[49].text, "session finished");
      h.bus.emit({
        type: "SESSION_OUTPUT", session_id: s.id, payload: { chunk: "password=hunter2" },
      });
      const r2 = await req(h, `/api/session/history?id=${s.id}`, USER_A);
      assert.ok(!r2.text.includes("hunter2"), "history must pass the scrub pipeline");
    } finally {
      await h.close();
    }
  });

  it("page shows the per-session actions AND the persistent terminal + browse UI", async () => {
    const h = await buildHarness();
    try {
      const page = await fetch(url(h, "/"), { signal: AbortSignal.timeout(5000) });
      const html = await page.text();
      for (const probe of ["vlive", "vhist", "vdel", "Last 50 lines", "Delete",
        "/api/session/history", "/api/session/delete",
        // personal Linux Terminal + directory browser (requirements 1/5/6)
        "termview", "Linux Terminal", "/api/terminal/start", "/api/browse",
        "ccwd", "cbrowse"])
        assert.ok(html.includes(probe), `page missing ${probe}`);
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
      // the trio: live button + last 50 lines + delete
      const texts = raw.inline_keyboard.flat().map((b: any) => b.text).join("|");
      assert.match(texts, /Last 50 lines/);
      assert.match(texts, /Delete session/);
    } finally {
      await h.close();
    }
  });

  it("no webapp.url configured → no web_app button anywhere (Mini App off)", async () => {
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
      const btns = replies[0].kb.inline_keyboard.flat();
      assert.ok(!btns.some((b: any) => b.web_app), "web_app button must stay hidden");
      // bot-side actions remain available without the Mini App
      assert.ok(btns.some((b: any) => String(b.text).includes("Last 50 lines")));
      assert.ok(btns.some((b: any) => String(b.text).includes("Delete session")));
    } finally {
      await h.close();
    }
  });
});

// ---------- 11. telegram trio: history + delete callbacks ----------
describe("telegram session trio (history / confirm / delete)", () => {
  function cbCtx(uid: number, data: string) {
    const replies: { text: string; kb?: any }[] = [];
    return {
      from: { id: uid },
      chat: { id: 1000 + uid },
      message: { text: "" },
      callbackQuery: { data, id: "c" },
      replies,
      reply: async (text: string, opts?: any) => {
        replies.push({ text, kb: opts?.reply_markup });
        return { message_id: 1 };
      },
      editMessageText: async (text: string) => {
        replies.push({ text });
      },
      answerCallbackQuery: async () => undefined,
    };
  }

  it("non-owner: hist50, delreq and del all get the generic deny; session untouched", async () => {
    const h = await buildHarness();
    try {
      const a = h.mk(USER_A);
      const controller = new TelegramController(h.app);
      for (const d of [`hist50:${a.id}`, `delreq:${a.id}`, `del:${a.id}`]) {
        const ctx = cbCtx(USER_B, d);
        await (controller as any).handleCallback(ctx);
        assert.deepEqual(ctx.replies.map((r) => r.text), [DENY_MESSAGE], `${d} must deny`);
      }
      assert.ok(h.db.getSession(a.id));
      assert.equal(h.runner.argv.length, 0);
    } finally {
      await h.close();
    }
  });

  it("owner: hist50 renders stored lines; delreq confirms; del removes panes + history", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A);
      h.db.setStatus(s.id, "WORKING");
      h.bus.emit({ type: "SESSION_OUTPUT", session_id: s.id, payload: { chunk: "hello stored" } });
      const controller = new TelegramController(h.app);

      const c1 = cbCtx(USER_A, `hist50:${s.id}`);
      await (controller as any).handleCallback(c1);
      assert.match(c1.replies[0].text, /\[AGENT\] hello stored/);

      const c2 = cbCtx(USER_A, `delreq:${s.id}`);
      await (controller as any).handleCallback(c2);
      assert.match(c2.replies[0].text, /Cannot be undone/);
      const btns = c2.replies[0].kb.inline_keyboard.flat();
      assert.ok(btns.some((b: any) => b.callback_data === `del:${s.id}`));
      assert.ok(btns.some((b: any) => b.callback_data === `sess:${s.id}`));

      const c3 = cbCtx(USER_A, `del:${s.id}`);
      await (controller as any).handleCallback(c3);
      assert.match(c3.replies[0].text, /deleted/);
      assert.equal(h.db.getSession(s.id), undefined);
      assert.equal(h.db.listEvents(s.id, 10).length, 0);
      // the agent pane was killed through the real SessionManager stop path
      assert.ok(h.runner.argv.some(
        (a) => a[0] === "kill-session" && a[a.indexOf("-t") + 1] === `teleops-${s.id}`));
    } finally {
      await h.close();
    }
  });

  it("selected session page (sess:) carries the trio: live web_app + Last 50 + Delete", async () => {
    const h = await buildHarness();
    try {
      const s = h.mk(USER_A);
      const controller = new TelegramController(h.app);
      const ctx = cbCtx(USER_A, `sess:${s.id}`);
      await (controller as any).handleCallback(ctx);
      const flat = ctx.replies[0]?.kb?.inline_keyboard?.flat?.() ?? [];
      assert.ok(flat.some((b: any) => b.web_app), "live Mini App button missing");
      assert.ok(flat.some((b: any) => b.callback_data === `hist50:${s.id}`));
      assert.ok(flat.some((b: any) => b.callback_data === `delreq:${s.id}`));
    } finally {
      await h.close();
    }
  });

  it("sessions screen with ZERO sessions still offers the 🖥 Linux Terminal button (requirement 6)", async () => {
    const h = await buildHarness();
    try {
      const controller = new TelegramController(h.app);
      const spec = (controller as any).sessionsSpec(USER_A);
      assert.match(spec.text, /No sessions yet/);
      assert.match(spec.text, /Linux Terminal/);
      const btn = spec.kb.inline_keyboard.flat().find((b: any) => b.web_app);
      assert.ok(btn, "web_app button missing on the empty list");
      assert.match(btn.web_app.url, /tab=terminal$/, "deep-link opens the terminal directly");
      // Mini App not configured → the button disappears, text stays usable
      h.app.config.webapp.url = "";
      const off = (controller as any).sessionsSpec(USER_A);
      assert.ok(!off.kb.inline_keyboard.flat().some((b: any) => b.web_app));
    } finally {
      await h.close();
    }
  });
});

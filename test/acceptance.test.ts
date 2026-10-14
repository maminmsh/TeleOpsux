/**
 * Root-cause-fix ACCEPTANCE tests (spec §10, 13 scenarios).
 *
 * SIMULATED environment — declared honestly: tmux and the agent processes are
 * faked by a recording ExecRunner; NO real process is spawned and no network
 * is used. What runs for REAL here: the whole TeleOps stack — DB, EventBus,
 * Tmux wrapper, SessionManager (preflight, pane-command launch, startup
 * verification, failStart, sendInput guards, crash polling), TerminalService,
 * OutputHub, SessionManager credential staging, and the TelegramController
 * callback/navigation logic.
 *
 * Real-host end-to-end (actual Qoder CLI spawn on the VPS, real Telegram
 * client) cannot be asserted from here and is reported separately.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { DB } from "../src/db/database";
import { EventBus } from "../src/core/event-bus";
import { LogHub } from "../src/logger/logger";
import { Tmux } from "../src/session/tmux";
import { AdapterRegistry } from "../src/adapters/registry";
import {
  SessionManager,
  outputDelta,
} from "../src/session/session-manager";
import type { ProjectFiles } from "../src/session/project-files";
import { SecretBox } from "../src/shared/secret-box";
import { CredentialService } from "../src/credentials/credential-service";
import { TelegramController } from "../src/telegram/bot";
import { OutputHub, sessionKey, terminalKey } from "../src/web/output-hub";
import { TerminalService } from "../src/web/terminal-service";
import { redactSecrets } from "../src/auth/access";
import { loadConfig } from "../src/config/config";
import type { DomainEvent, SessionRecord } from "../src/shared/types";
import type { ExecOptions, ExecResult, ExecRunner } from "../src/exec/exec-runner";
import type { App } from "../src/core/container";
import { makeConfig, tempDbFile, tempDir } from "./helpers";

const ADMIN = 100;
const USER_A = 111;
const USER_B = 222;
const KEY_A = "qoder-key-AAAA-0123456789abcdef";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const gone = (): ExecResult => ({ code: 1, stdout: "", stderr: "no session" });

/**
 * Records every argv line and script the code would run on the session host,
 * and simulates tmux with remain-on-exit semantics:
 *  - `missingBins` makes the `command -v` launch preflight fail for a binary;
 *  - `deadPanes` marks a pane's process exited with a given code;
 *  - `launches` keeps the pane COMMAND (what tmux execs as the pane process);
 *  - `files` is the fake session-host filesystem for staged credential files.
 */
class FakeRunner implements ExecRunner {
  kind = "local" as const;
  argv: string[][] = [];
  names = new Set<string>();
  panes = new Map<string, string>();
  launches = new Map<string, string>();
  files = new Map<string, string>();
  visible: string[] = [];
  stdinWrites: string[] = [];
  missingBins = new Set<string>();
  deadPanes = new Map<string, number>();
  /** $HOME of the fake session-host transport user. */
  home = "/home/ops";

  private target(args: string[]): string {
    return args[args.indexOf("-t") + 1] ?? "";
  }

  async exec(cmd: string, args: string[]): Promise<ExecResult> {
    this.argv.push(args);
    this.visible.push([cmd, ...args].join(" "));
    if (cmd === "sh" && args[0] === "-lc") {
      // transport $HOME probe used by the personal terminal
      if ((args[1] ?? "") === 'cd "$HOME" && pwd -P') return ok(`${this.home}\n`);
      // SessionManager preflight: sh -lc 'command -v "$1"' teleops-preflight <bin>
      const bin = args[args.length - 1]!;
      if (this.missingBins.has(bin))
        return { code: 1, stdout: "", stderr: `${bin}: not found` };
      return ok(`${bin.startsWith("/") ? bin : "/usr/local/bin/" + bin}\n`);
    }
    if (cmd !== "tmux") return ok();
    switch (args[0]) {
      case "-V":
        return ok("tmux 3.4\n");
      case "ls":
        return ok([...this.names].join("\n") + (this.names.size ? "\n" : ""));
      case "new-session": {
        const s = args[args.indexOf("-s") + 1]!;
        this.names.add(s);
        const ci = args.indexOf("-c");
        const initial = args.length > ci + 2 ? args[ci + 2]! : "";
        if (initial) this.launches.set(s, initial);
        this.panes.set(s, initial ? "" : `${s}$ `);
        return ok();
      }
      case "send-keys": {
        const t = this.target(args);
        const cur = this.panes.get(t) ?? `${t}$ `;
        if (args.includes("-l")) this.panes.set(t, cur + args[args.length - 1]);
        else if (args[args.length - 1] === "Enter") this.panes.set(t, cur + "\n");
        else this.panes.set(t, cur + `<${args[args.length - 1]}>`);
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
      default:
        return ok();
    }
  }

  async execScript(script: string, opts?: ExecOptions): Promise<ExecResult> {
    this.visible.push(script);
    if (opts?.input !== undefined) {
      this.stdinWrites.push(opts.input);
      const write = script.match(/cat > "([^"]+)"/);
      if (write) this.files.set(write[1]!, opts.input);
    }
    const remove = script.match(/^rm -f "(.+)"$/);
    if (remove) this.files.delete(remove[1]!);
    return ok();
  }

  typedTo(target: string): string[] {
    return this.argv
      .filter((a) => a[0] === "send-keys" && a.includes("-l") && a[a.indexOf("-t") + 1] === target)
      .map((a) => a[a.length - 1]!);
  }
  newSessionCount(targetName: string): number {
    return this.argv.filter((a) => a[0] === "new-session" && a.includes(targetName)).length;
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 6000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 60));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Full stack on a fake host transport. attachHost is used deliberately so the
 * credential-staging execScript path is ALSO faked — nothing touches the real
 * filesystem. heartbeat_interval_seconds=1 makes the crash poller fast.
 * `qoderCommand` overrides the Qoder agent binary exactly like QODER_BIN does
 * (done per-harness so no test mutates the shared process env).
 */
function build(qoderCommand?: string) {
  const dir = tempDir("teleops-acc-");
  // makeConfig -> loadConfig reads process.env.QODER_BIN, and Node runs
  // sibling `it`s concurrently, so the QODER_BIN unit test can otherwise leak
  // its value into this harness. Clear it so every build() is deterministic;
  // tests that want a custom path pass `qoderCommand` explicitly instead.
  delete process.env.QODER_BIN;
  const config = makeConfig({
    allowed_users: [USER_A, USER_B, ADMIN],
    admin_users: [ADMIN],
  });
  config.paths.database_file = path.join(dir, "data", "t.db");
  config.paths.log_root = path.join(dir, "logs");
  config.sessions.heartbeat_interval_seconds = 1;
  if (qoderCommand)
    config.agents.qoder = { ...config.agents.qoder, command: qoderCommand };

  const db = new DB(config.paths.database_file);
  const bus = new EventBus(db);
  const logs = new LogHub(config.paths.log_root);
  const runner = new FakeRunner();
  const tmux = new Tmux(config.sessions.tmux_prefix, runner);
  const adapters = new AdapterRegistry(config.agents);
  const sessions = new SessionManager(db, bus, tmux, adapters, logs, config);
  const credentials = new CredentialService(db, new SecretBox(path.join(dir, "key")));
  sessions.setCredentials(credentials);
  const events: DomainEvent[] = [];
  bus.on("event", (e) => events.push(e));

  // Owned by USER_A + globally active, so the per-user terminal's transport
  // gate (effectiveActiveHostId === sessions.currentHostId) sees a consistent
  // setup: USER_A (and every admin) legitimately lives on this host.
  const host = db.createHost({
    name: "h1", host: "h1.example", port: 22, username: "ops",
    password_enc: "iv:tag:data", owner_telegram_user_id: USER_A, visibility: "shared",
  });
  db.setActiveHost(host.id);
  sessions.attachHost({
    hostId: host.id,
    runner,
    tmux,
    projectFiles: {
      logDir: (root: string) => `${root}/.teleops/logs`,
      ensureLogDir: async () => undefined,
      upsertMemory: async () => undefined,
      fileSize: async () => 0,
    } as unknown as ProjectFiles,
  });

  const app = {
    config, db, bus, logs, sessions, adapters, credentials,
    tracker: { report() {} },
    runner,
    git: { currentBranch: async () => null, isRepo: async () => false },
    projectFiles: null,
    serverMode: { connection: null },
  } as unknown as App;

  const hub = new OutputHub(bus, (t) => credentials.redactAll(redactSecrets(t)));
  const terminals = new TerminalService(app, hub);
  // the personal terminal is per-USER — deleting an AI session must never
  // kill it; only its own live ring is forgotten
  sessions.onDeleted((id) => {
    hub.forget(sessionKey(id));
  });

  const mk = (
    owner: number | null,
    agent = "shell",
    cwd = "/srv/app",
  ): SessionRecord =>
    db.createSession({
      name: `s-${owner ?? "legacy"}`,
      project_id: null,
      agent_type: agent,
      cwd,
      owner_telegram_user_id: owner,
    });

  function close(): void {
    sessions.shutdown();
    terminals.shutdown();
    hub.stop();
    db.close();
    logs.close();
  }
  const targetOf = (id: number) => `${config.sessions.tmux_prefix}-${id}`;
  return { app, db, bus, logs, hub, runner, sessions, terminals, credentials, events, mk, close, targetOf, config };
}
type H = ReturnType<typeof build>;

// ---------------------------------------------------------------------------
// 1. Missing executable → clean, actionable failure (the "qoder: not found" bug)
// ---------------------------------------------------------------------------
describe("acceptance 1: missing executable fails cleanly", () => {
  it("preflight failure never reaches WORKING, creates no pane, and explains what to do", async () => {
    const h = build();
    try {
      h.credentials.save(USER_A, KEY_A);
      h.runner.missingBins.add("qoder"); // the exact production symptom
      const s = h.mk(USER_A, "qoder");
      await assert.rejects(h.sessions.start(s.id), /"qoder" was not found on/);

      const rec = h.db.getSession(s.id)!;
      assert.equal(rec.status, "ERROR", "a never-started agent must not claim WORKING");
      assert.match(rec.waiting_reason!, /was not found/);
      assert.match(rec.waiting_reason!, /Install it, or point agents/);
      assert.match(rec.waiting_reason!, /absolute path|QODER_BIN/);
      // no pane was ever created — nothing survives to swallow chat input
      assert.equal(h.runner.names.has(h.targetOf(s.id)), false);
      // and the launch preflight ran on the SESSION HOST transport
      // (argv rows store the ARGUMENTS; runner.visible keeps the cmd too)
      assert.ok(
        h.runner.argv.some(
          (a) => a[0] === "-lc" && a[1] === 'command -v "$1"' && a[a.length - 1] === "qoder",
        ),
      );
      assert.ok(!h.runner.visible.join("\n").includes(KEY_A), "key never enters a command line");
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Configured executable path → preflight resolves it and the pane execs it
// ---------------------------------------------------------------------------
describe("acceptance 2: configured executable path is honoured", () => {
  it("QODER_BIN overrides the agent command in config", () => {
    process.env.QODER_BIN = "/opt/custom/qoder";
    try {
      const cfg = loadConfig(path.join(tempDir(), "none.yaml"));
      assert.equal(cfg.agents.qoder.command, "/opt/custom/qoder");
    } finally {
      delete process.env.QODER_BIN;
    }
  });

  it("preflight resolves the configured ABSOLUTE path and the pane command execs it at the session cwd", async () => {
    // Configure the path through the injected config, NOT a global env var —
    // mutating process.env here would leak into other async tests that share
    // the module and run interleaved.
    const h = build("/opt/custom/qoder");
    try {
      h.credentials.save(USER_A, KEY_A);
      const s = h.mk(USER_A, "qoder", "/srv/app");
      await h.sessions.start(s.id);

      const preflight = h.runner.argv.find(
        (a) => a[0] === "-lc" && a[1] === 'command -v "$1"' && a[a.length - 1] === "/opt/custom/qoder",
      );
      assert.ok(preflight, "preflight never ran for the configured absolute path");
      assert.equal(preflight![preflight!.length - 1], "/opt/custom/qoder");

      const ns = h.runner.argv.find((a) => a[0] === "new-session" && a.includes(h.targetOf(s.id)));
      assert.ok(ns, "agent pane never created");
      assert.equal(ns![ns!.indexOf("-c") + 1], "/srv/app", "pane opens in the session cwd");
      const paneCommand = ns![ns!.length - 1]!;
      assert.match(paneCommand, /exec "\/opt\/custom\/qoder"/, "pane execs the RESOLVED absolute path");
      assert.match(paneCommand, /rm -f/, "pane command deletes the staged credential after reading");

      const rec = h.db.getSession(s.id)!;
      assert.ok(["WORKING", "STARTING"].includes(rec.status));
      // the key never appears in any argv line or script text — only stdin
      assert.ok(!h.runner.visible.join("\n").includes(KEY_A));
      assert.equal(h.runner.stdinWrites.filter((k) => k === KEY_A).length, 1);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Immediate exit → failed state; chat can never leak into a surviving shell
// ---------------------------------------------------------------------------
describe("acceptance 3: agent that exits immediately fails cleanly, no shell leak", () => {
  it("start reports the real exit code, kills the pane, and refuses later chat input", async () => {
    const h = build();
    try {
      const s = h.mk(USER_A);
      h.runner.deadPanes.set(h.targetOf(s.id), 1); // dies the instant it starts
      await assert.rejects(
        h.sessions.start(s.id),
        /exited immediately \(exit code 1\)/,
      );
      const rec = h.db.getSession(s.id)!;
      assert.equal(rec.status, "ERROR");

      // the failed agent left NO shell behind: pane gone entirely
      assert.equal(h.runner.names.has(h.targetOf(s.id)), false);
      // a task typed later is REFUSED, not executed as a Linux command
      await assert.rejects(
        h.sessions.sendInput(s.id, "سلام، لطفاً پروژه را بساز"),
        /not found|resume\/restart|no longer running/,
      );
      assert.deepEqual(h.runner.typedTo(h.targetOf(s.id)), [], "chat text never typed anywhere");
    } finally {
      h.close();
    }
  });

  it("a crashed Qoder launch cleans the staged credential file", async () => {
    const h = build();
    try {
      h.credentials.save(USER_A, KEY_A);
      const s = h.mk(USER_A, "qoder");
      h.runner.deadPanes.set(h.targetOf(s.id), 137);
      await assert.rejects(h.sessions.start(s.id), /exited immediately/);
      await waitFor(() => h.runner.files.size === 0, 2000, "credential file cleanup");
      assert.equal(h.runner.files.size, 0, "staged key must not survive a failed start");
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Agent chat reaches the agent pane (and only the agent pane)
// ---------------------------------------------------------------------------
describe("acceptance 4: agent chat input routing", () => {
  it("sendInput on a running session types to the agent pane once, with Enter, and records it", async () => {
    const h = build();
    try {
      const s = h.mk(USER_A);
      await h.sessions.start(s.id);
      await h.sessions.sendInput(s.id, "refactor the parser");
      assert.deepEqual(h.runner.typedTo(h.targetOf(s.id)), ["refactor the parser"]);
      // Enter pressed as a key (not literal) right after the text
      const enter = h.runner.argv.find((a) => a[0] === "send-keys" && a[a.length - 1] === "Enter");
      assert.ok(enter, "message never submitted with Enter");
      const rows = h.db.listMessages(s.id);
      assert.equal(rows.filter((r) => r.direction === "USER_TO_AGENT" && r.content === "refactor the parser").length, 1);
      // no personal terminal had been opened — nothing could shadow the agent
      assert.equal(h.runner.names.has(`teleops-term-u${USER_A}`), false);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. PERSONAL terminal: independent of AI sessions, `pwd` comes back from the
//    real pane capture stream
// ---------------------------------------------------------------------------
describe("acceptance 5: personal terminal shell round-trip", () => {
  const termTarget = () => `teleops-term-u${USER_A}`;

  it("a typed pwd shows up as shell output through the capture-diff pipeline — with ZERO AI sessions", async () => {
    const h = build();
    try {
      // no session exists at all: the terminal is per-user, not per-session
      const st = await h.terminals.start(USER_A);
      assert.equal(st.active, true);
      assert.equal(st.cwd, h.runner.home, "shell opens at the transport $HOME");
      await h.terminals.sendText(USER_A, "pwd");
      await waitFor(
        () =>
          h.hub
            .snapshot(terminalKey(USER_A), 200)
            .some((l) => l.source === "shell" && l.text.includes("pwd")),
        6000,
        "pwd echoed from the pane",
      );
      assert.deepEqual(h.runner.typedTo(termTarget()), ["pwd"]);
      // and closing/reopening REUSES the same live pane (browser close ≠ kill)
      h.terminals.shutdown();
      const again = await h.terminals.start(USER_A);
      assert.equal(again.active, true);
      assert.equal(
        h.runner.argv.filter((a) => a[0] === "new-session" && a.includes(termTarget())).length,
        1,
        "no second shell spawned for the same user",
      );
    } finally {
      h.close();
    }
  });

  it("an exited shell is refused input and cannot look live", async () => {
    const h = build();
    try {
      await h.terminals.start(USER_A);
      h.runner.deadPanes.set(termTarget(), 0); // user typed `exit`
      await assert.rejects(h.terminals.sendText(USER_A, "ls"), /shell has exited/);
      assert.equal(h.terminals.status(USER_A).active, false, "dead shell never reports active");
      // the death is surfaced in the stream (the kill path appends
      // "terminal closed"; the poller's own notice says "shell process
      // exited") — never left looking live with no process behind it.
      await waitFor(
        () =>
          h.hub
            .snapshot(terminalKey(USER_A), 200)
            .some(
              (l) =>
                l.source === "system" &&
                /shell process exited|terminal closed/.test(l.text),
            ),
        6000,
        "death notice in stream",
      );
    } finally {
      h.close();
    }
  });

  it("two users get two isolated shells: B never sees A's shell ring", async () => {
    const h = build();
    try {
      await h.terminals.start(USER_A);
      h.hub.append(terminalKey(USER_A), "shell", "A-SECRET-LINE");
      const bLines = h.hub.snapshot(terminalKey(USER_B), 100).map((l) => l.text);
      assert.ok(!bLines.some((t) => t.includes("A-SECRET-LINE")));
      // USER_B is not on the active host (owned by USER_A, B is not admin):
      // the transport gate refuses with an actionable error, not a silent mix
      await assert.rejects(h.terminals.start(USER_B), /active server differs/);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 6 + 8. Incremental streaming and duplication eliminated AT THE SOURCE
// ---------------------------------------------------------------------------
describe("acceptance 6/8: incremental output, dedupe at the source", () => {
  it("outputDelta is prefix/scroll/redraw-safe", () => {
    assert.equal(outputDelta("abc", "abc"), "");
    assert.equal(outputDelta("run\n", "run\nnext"), "next"); // plain append → tail only
    // scrolling window: previous lines scrolled off, only the new remainder
    assert.equal(outputDelta("A\nB\nC", "B\nC\nD"), "D");
    // redraw in place: only the changed positional line
    assert.equal(outputDelta("spin |\nkeep", "spin /\nkeep"), "spin /");
    // legitimately repeated text is NOT discarded
    assert.equal(outputDelta("test ok", "test ok\ntest ok"), "\ntest ok");
  });

  it("the poller emits each pane change exactly once — no re-emits while idle, none on scroll", async () => {
    const h = build();
    try {
      const s = h.mk(USER_A);
      await h.sessions.start(s.id);
      const chunksOf = () =>
        h.events.filter(
          (e) => e.type === "SESSION_OUTPUT" && e.session_id === s.id,
        );
      // static pane: give the 1s poller two full cycles — must stay silent
      await sleep(2300);
      assert.equal(chunksOf().length, 0, "idle pane must not emit anything");

      h.runner.panes.set(h.targetOf(s.id), "building module A\nbuilding module B");
      await waitFor(() => chunksOf().length === 1, 5000, "first chunk");
      assert.match(String(chunksOf()[0]!.payload?.chunk), /building module A/);
      await sleep(1500);
      assert.equal(chunksOf().length, 1, "unchanged pane must not re-emit");

      // window scrolls one line off — old lines must NOT be re-delivered
      h.runner.panes.set(h.targetOf(s.id), "building module B\nbuilding module C");
      await waitFor(() => chunksOf().length === 2, 5000, "scroll chunk");
      const chunk = String(chunksOf()[1]!.payload?.chunk);
      assert.equal(chunk, "building module C");
      assert.ok(!chunk.includes("building module B"), "scrolled-off line re-emitted");
      // the live ring saw the same single emission (same source, no second copy)
      const texts = h.hub.snapshot(sessionKey(s.id), 200).filter((l) => l.source === "agent").map((l) => l.text);
      assert.equal(texts.filter((t) => t === "building module C").length, 1);
      assert.equal(texts.filter((t) => t === "building module B").length, 1);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Multi-turn conversation
// ---------------------------------------------------------------------------
describe("acceptance 7: multi-turn chat", () => {
  it("sequential messages all reach the same live agent pane in order", async () => {
    const h = build();
    try {
      const s = h.mk(USER_A);
      await h.sessions.start(s.id);
      await h.sessions.sendInput(s.id, "turn one");
      await h.sessions.sendInput(s.id, "turn two");
      assert.deepEqual(h.runner.typedTo(h.targetOf(s.id)), ["turn one", "turn two"]);
      const rows = h.db.listMessages(s.id);
      assert.equal(rows.filter((r) => r.direction === "USER_TO_AGENT").length, 2);
      assert.equal(h.db.getSession(s.id)!.status, "WORKING");
      assert.equal(h.runner.newSessionCount(h.targetOf(s.id)), 1, "no relaunch per turn");
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Reconnect without duplicate launch; resume from sequence cursor
// ---------------------------------------------------------------------------
describe("acceptance 9: reconnect/restart does not duplicate the process", () => {
  it("repeated start/resume on a live agent reuses the single pane", async () => {
    const h = build();
    try {
      const s = h.mk(USER_A);
      await h.sessions.start(s.id);
      assert.equal(h.runner.newSessionCount(h.targetOf(s.id)), 1);
      const started = () => h.events.filter((e) => e.type === "SESSION_STARTED" && e.session_id === s.id).length;
      assert.equal(started(), 1);

      await h.sessions.start(s.id); // double-tap while live
      assert.equal(h.runner.newSessionCount(h.targetOf(s.id)), 1, "no second process");
      assert.equal(started(), 1, "lifecycle line not re-emitted");

      await h.sessions.resume(s.id); // pane still alive → bookkeeping only
      assert.equal(h.runner.newSessionCount(h.targetOf(s.id)), 1);
      assert.ok(h.events.some((e) => e.type === "SESSION_RECONNECTED" && e.session_id === s.id));
      assert.equal(h.db.getSession(s.id)!.pid, 4321, "pid re-recorded from the live pane");

      // stream resume math: a client cursor replays exactly the newer lines
      h.hub.append(sessionKey(s.id), "agent", "l1");
      const cursor = h.hub.lastSeq(sessionKey(s.id));
      h.hub.append(sessionKey(s.id), "agent", "l2");
      const replay = h.hub.since(sessionKey(s.id), cursor).map((l) => l.text);
      assert.ok(!replay.includes("l1"));
      assert.ok(replay.includes("l2"));
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 10 + 11. Telegram dashboard: EDIT one message; Back restores the screen
// ---------------------------------------------------------------------------
describe("acceptance 10/11: Telegram navigation never floods the chat", () => {
  interface NavCalls {
    ctxEdits: string[]; // edits of the tapped message
    apiEdits: string[]; // edits of the stored dashboard message
    replies: string[]; // brand-new messages — must stay empty while navigating
    acks: number;
  }

  function buildNav() {
    const config = makeConfig({
      allowed_users: [USER_A, USER_B, ADMIN],
      admin_users: [ADMIN],
    });
    const dir = tempDir("teleops-nav-");
    const db = new DB(tempDbFile(dir));
    const calls: NavCalls = { ctxEdits: [], apiEdits: [], replies: [], acks: 0 };
    const app = {
      config,
      db,
      bus: { on() {}, emit() {} },
      logs: { system: { info() {}, warn() {}, error() {} }, audit: { audit() {} }, session: { sessionOutput() {} } },
      sessions: {
        remoteMode: false,
        capture: async () => "",
        currentHostId: null,
        tmuxTransport: null,
      },
      hosts: { getHost: () => undefined },
      adapters: { ids: () => ["shell"], get: () => undefined },
      credentials: {
        status: () => "missing",
        hasCredential: () => false,
        revealForLaunch: () => null,
        containsStoredSecret: () => false,
        redactAll: (t: string) => t,
      },
      tracker: { modules: () => [], state: () => "ok", recent: () => [], count24h: () => 0, report() {} },
      serverMode: { connection: null },
      monitor: { metrics: async () => ({}), topProcesses: async () => [], fullReport: async () => null },
    } as unknown as App;
    const controller = new TelegramController(app);
    // stub the Bot API edit (grammy would hit the network)
    (controller as unknown as { bot: { api: Record<string, unknown> } }).bot.api.editMessageText =
      async (_chatId: number, _messageId: number, text: string) => {
        calls.apiEdits.push(text);
      };

    let seq = 4242; // the real dashboard message id in the chat
    const tap = (uid: number, data: string) => ({
      from: { id: uid },
      chat: { id: 7000 + uid },
      callbackQuery: { data, id: "q", message: { chat: { id: 7000 + uid }, message_id: seq } },
      editMessageText: async (text: string) => {
        calls.ctxEdits.push(text);
        seq++; // next tap would land on the newly edited message, not a fresh one
      },
      reply: async (text: string) => {
        calls.replies.push(text);
        return { message_id: 999 };
      },
      answerCallbackQuery: async () => {
        calls.acks++;
      },
    });
    const press = async (uid: number, data: string) =>
      (controller as unknown as { handleCallback(ctx: unknown): Promise<void> }).handleCallback(tap(uid, data));
    const state = (uid: number) =>
      (controller as unknown as { state: Map<number, { navStack?: string[]; dashboard?: { key: string } }> }).state.get(uid);
    return { db, calls, press, state };
  }

  it("menu taps EDIT the existing dashboard message — zero new messages, every tap acked", async () => {
    const n = buildNav();
    try {
      await n.press(ADMIN, "menu:main");
      await n.press(ADMIN, "nav:sessions");
      assert.deepEqual(n.calls.replies, [], "navigation must not send new messages");
      assert.equal(n.calls.ctxEdits.length, 2, "each screen was an edit");
      assert.equal(n.calls.acks, 2, "every callback acknowledged");
      assert.equal(n.state(ADMIN)?.dashboard?.key, "sessions");
      // re-tapping the same screen still never stacks a message and never
      // pushes a duplicate back entry
      await n.press(ADMIN, "nav:sessions");
      assert.deepEqual(n.calls.replies, []);
      assert.deepEqual(n.state(ADMIN)?.navStack, ["main"], "same-key tap pushed no duplicate");
    } finally {
      n.db.close();
    }
  });

  it("Back walks the recorded screen stack and restores the correct screens", async () => {
    const n = buildNav();
    try {
      await n.press(ADMIN, "menu:main");
      await n.press(ADMIN, "nav:sessions");
      await n.press(ADMIN, "nav:projects");
      assert.deepEqual(n.state(ADMIN)?.navStack, ["main", "sessions"]);
      const last = () => n.calls.ctxEdits[n.calls.ctxEdits.length - 1]!;

      await n.press(ADMIN, "back");
      assert.match(last(), /🤖 AI SESSIONS/, "back → sessions screen");
      assert.deepEqual(n.state(ADMIN)?.navStack, ["main"]);

      await n.press(ADMIN, "back");
      assert.match(last(), /AI COMMAND CENTER/, "back → main screen");
      assert.deepEqual(n.state(ADMIN)?.navStack, []);

      await n.press(ADMIN, "back"); // empty stack → stays on main, no crash
      assert.match(last(), /AI COMMAND CENTER/);
      assert.equal(n.calls.replies.length, 0, "still zero new messages across the whole walk");
      assert.equal(n.calls.acks, 6);
    } finally {
      n.db.close();
    }
  });

  it("a non-admin tapping an admin screen is refused WITHOUT navigating", async () => {
    const n = buildNav();
    try {
      await n.press(USER_A, "menu:main");
      await n.press(USER_A, "nav:settings");
      assert.match(n.calls.replies.join("\n"), /administrators/);
      assert.equal(n.state(USER_A)?.dashboard?.key, "main", "dashboard still shows main");
    } finally {
      n.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Security: no credential material in any surfaced string
// ---------------------------------------------------------------------------
describe("acceptance 12: credentials never surface", () => {
  it("a failed Qoder launch exposes the key in NO log, DB field, event or stream line", async () => {
    const h = build();
    try {
      h.credentials.save(USER_A, KEY_A);
      h.runner.missingBins.add("qoder");
      const s = h.mk(USER_A, "qoder");
      await assert.rejects(h.sessions.start(s.id), /was not found/);

      const surfaces: string[] = [
        h.runner.visible.join("\n"), // every command line the host would see
        JSON.stringify(h.db.getSession(s.id)), // waiting_reason, last_output…
        JSON.stringify(h.events), // every emitted domain event payload
        h.hub.snapshot(sessionKey(s.id), 500).map((l) => l.text).join("\n"), // stream lines
      ];
      for (const surface of surfaces)
        assert.ok(!surface.includes(KEY_A), "secret surfaced in: " + surface.slice(0, 120));
    } finally {
      h.close();
    }
  });

  it("agent output that prints its own key is redacted before the stream/db layer", async () => {
    const h = build();
    try {
      h.credentials.save(USER_A, KEY_A);
      const s = h.mk(USER_A);
      await h.sessions.start(s.id);
      // Two distinct secret shapes: a `key=value` line (caught by
      // redactSecrets → "…: ***") and the bare stored credential value
      // (caught by the stored-key pass → "***REDACTED***").
      h.bus.emit({
        type: "SESSION_OUTPUT",
        session_id: s.id,
        payload: { chunk: `password=hunter2 then ${KEY_A} inline` },
      });
      const line = h.hub.snapshot(sessionKey(s.id), 10).find((l) => l.text.includes("inline"));
      assert.ok(line, "output line missing");
      assert.ok(!line.text.includes(KEY_A), "stored key leaked into a stream line");
      assert.ok(!line.text.includes("hunter2"), "inline secret leaked into a stream line");
      assert.match(line.text, /password: \*\*\*/, "redactSecrets layer did not fire");
      assert.match(line.text, /\*\*\*REDACTED\*\*\*/, "stored-key redaction layer did not fire");
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 13. Stop / crash consistency with the real process state
// ---------------------------------------------------------------------------
describe("acceptance 13: stop and failure consistency", () => {
  it("stop kills the pane, lands on STOPPED, and further input is refused", async () => {
    const h = build();
    try {
      const s = h.mk(USER_A);
      await h.sessions.start(s.id);
      await h.sessions.stop(s.id);
      assert.equal(h.db.getSession(s.id)!.status, "STOPPED");
      assert.equal(h.runner.names.has(h.targetOf(s.id)), false, "pane really killed");
      await assert.rejects(h.sessions.sendInput(s.id, "still there?"), /STOPPED/);
      // the PERSONAL terminal is a different thing entirely: it was never
      // opened, and stopping a session neither opens nor kills it
      await assert.rejects(h.terminals.sendText(USER_A, "ls"), /Terminal is not open/);
      assert.equal(h.runner.names.has(`teleops-term-u${USER_A}`), false);
    } finally {
      h.close();
    }
  });

  it("a process death mid-run is observed by the poller exactly once → CRASHED + notice", async () => {
    const h = build();
    try {
      const s = h.mk(USER_A);
      await h.sessions.start(s.id);
      h.runner.panes.set(h.targetOf(s.id), "working on task");
      await waitFor(
        () => h.events.some((e) => e.type === "SESSION_OUTPUT" && e.session_id === s.id),
        5000,
        "baseline output observed",
      );
      h.runner.deadPanes.set(h.targetOf(s.id), 137); // OOM-killed for real
      await waitFor(() => h.db.getSession(s.id)!.status === "CRASHED", 6000, "crash observed");

      const crashes = () =>
        h.events.filter((e) => e.type === "PROCESS_CRASHED" && e.session_id === s.id).length;
      assert.equal(crashes(), 1);
      const reason = h.events.find((e) => e.type === "PROCESS_CRASHED")!.payload as { reason: string };
      assert.match(reason.reason, /exited \(code 137\)/);
      // the stream says so, once — and stays consistent afterwards
      const notices = () =>
        h.hub.snapshot(sessionKey(s.id), 500).filter((l) => l.source === "system" && l.text.includes("agent process crashed")).length;
      await sleep(2300); // two more poll cycles
      assert.equal(crashes(), 1, "crash never re-reported");
      assert.equal(notices(), 1);
      assert.equal(h.db.getSession(s.id)!.status, "CRASHED");
      // a crashed session cannot keep streaming as if alive
      await assert.rejects(h.sessions.sendInput(s.id, "continue"), /resume\/restart/);
    } finally {
      h.close();
    }
  });
});

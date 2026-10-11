import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DB } from "../src/db/database";
import { TelegramController } from "../src/telegram/bot";
import { HostService } from "../src/ssh/host-service";
import { CredentialService } from "../src/credentials/credential-service";
import { SecretBox } from "../src/shared/secret-box";
import { makeConfig, tempDbFile, tempDir } from "./helpers";
import type { App } from "../src/core/container";
import type { SessionRecord } from "../src/shared/types";

const ADMIN = 100;
const USER_A = 111;
const USER_B = 222;

interface Calls {
  sendInput: Array<{ id: number; text: string }>;
  capture: number[];
  stop: number[];
  resolved: number[];
  created: Array<{ owner: number | null; project_id: number | null }>;
}

function buildApp() {
  const config = makeConfig({
    allowed_users: [USER_A, USER_B, ADMIN],
    admin_users: [ADMIN],
  });
  const db = new DB(tempDbFile(tempDir("teleops-bot-")));
  const calls: Calls = { sendInput: [], capture: [], stop: [], resolved: [], created: [] };
  const keyFile = `${tempDir()}/teleops.key`;
  const hosts = new HostService(db, keyFile, config);
  const credentials = new CredentialService(db, new SecretBox(keyFile));

  const sessions = {
    remoteMode: false,
    capture: async (id: number) => {
      calls.capture.push(id);
      return "agent output password=hunter2 done";
    },
    sendInput: async (id: number, text: string) => {
      calls.sendInput.push({ id, text });
    },
    stop: async (id: number) => {
      calls.stop.push(id);
    },
    resume: async () => undefined,
    summary: () => null,
    create: async (p: {
      name: string;
      project_id: number | null;
      agent: string;
      cwd: string;
      owner_telegram_user_id?: number | null;
    }) => {
      calls.created.push({ owner: p.owner_telegram_user_id ?? null, project_id: p.project_id });
      return db.createSession({
        name: p.name,
        project_id: p.project_id,
        agent_type: p.agent,
        cwd: p.cwd,
        owner_telegram_user_id: p.owner_telegram_user_id ?? null,
      });
    },
    start: async (id: number) => db.getSession(id),
  };

  const git = {
    isRepo: async () => true,
    status: async () => ({ branch: "main", clean: true, ahead: 0, behind: 0, modified: [] }),
    diff: async () => ({ stat: "1 file changed", diff: "+x" }),
    log: async () => "abc123 msg",
    numstat: async () => ({ files: 1, insertions: 2, deletions: 0 }),
    add: async () => ({ ok: true, stderr: "" }),
    commit: async () => ({ ok: true, stderr: "" }),
    push: async () => ({ ok: true, stderr: "" }),
    currentBranch: async () => null,
  };

  const approvals = {
    pending: () => [],
    request: (p: { session_id: number | null; action_type: string; payload: unknown }) =>
      db.createApproval({
        session_id: p.session_id,
        action_type: p.action_type,
        payload: p.payload as Record<string, unknown>,
      }),
    registerHandler: () => undefined,
    resolve: (id: number) => {
      calls.resolved.push(id);
    },
  };

  const app = {
    config,
    db,
    hosts,
    logs: {
      system: { info() {}, warn() {}, error() {} },
      audit: { audit() {} },
      session: { sessionOutput() {} },
    },
    bus: { on() {}, emit() {} },
    sessions,
    credentials,
    provision: null,
    adapters: {
      ids: () => ["shell"],
      get: (id: string) =>
        id === "qoder"
          ? ({ id: "qoder", credentialEnvVar: "QODER_PERSONAL_ACCESS_TOKEN" } as never)
          : undefined,
    },
    git,
    monitor: { metrics: async () => ({}), topProcesses: async () => [], start() {}, stop() {} },
    approvals,
    policy: { decide: () => "approval" },
    notifications: { registerSink() {} },
    runner: {
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      execScript: async () => ({ code: 0, stdout: "log tail", stderr: "" }),
    },
    tracker: {
      report() {},
      modules: () => [],
      state: () => "ok",
      recent: () => [],
      count24h: () => 0,
    },
    projectFiles: null,
    serverMode: {
      connection: null,
      switchActiveHost: async () => undefined,
      ensureMonitorRunning() {},
    },
  } as unknown as App;

  const controller = new TelegramController(app);
  return { app, db, controller, calls, credentials };
}

function fakeCtx(
  userId: number,
  opts: { data?: string; match?: string; text?: string } = {},
) {
  const replies: string[] = [];
  return {
    from: { id: userId },
    chat: { id: 1000 + userId },
    message: { text: opts.text ?? "hello" },
    callbackQuery: opts.data ? { data: opts.data } : undefined,
    match: opts.match,
    msg: { message_id: 1 },
    replies,
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 1 };
    },
    editMessageText: async (text: string) => {
      replies.push(text);
    },
    answerCallbackQuery: async () => undefined,
  };
}

const DENIED = "⛔ You do not have access to this resource.";

function mkSession(db: DB, owner: number | null, name = "s"): SessionRecord {
  return db.createSession({
    name,
    project_id: null,
    agent_type: "shell",
    cwd: "/tmp",
    owner_telegram_user_id: owner,
  });
}

describe("telegram layer: user B cannot touch user A's resources", () => {
  it("enterChat: foreign session → generic deny, no output captured", async () => {
    const { db, controller, calls } = buildApp();
    const a = mkSession(db, USER_A);
    const ctx = fakeCtx(USER_B, { match: String(a.id) });
    await (controller as any).enterChat(ctx, a.id);
    assert.deepEqual(ctx.replies, [DENIED]);
    assert.equal(calls.capture.length, 0);
  });

  it("enterChat: owner passes; admin passes for any session", async () => {
    const { db, controller, calls } = buildApp();
    const a = mkSession(db, USER_A);
    const ctxA = fakeCtx(USER_A);
    await (controller as any).enterChat(ctxA, a.id);
    assert.ok(ctxA.replies.some((r) => r.startsWith("💬")));
    const ctxAdm = fakeCtx(ADMIN);
    await (controller as any).enterChat(ctxAdm, a.id);
    assert.ok(ctxAdm.replies.some((r) => r.startsWith("💬")));
    assert.equal(calls.capture.length, 2);
  });

  it("/send: foreign session denied and never sent; owner's input goes through SessionManager", async () => {
    const { db, controller, calls } = buildApp();
    const a = mkSession(db, USER_A);
    const ctxB = fakeCtx(USER_B, { match: `${a.id} rm -rf /` });
    await controller.sendCommand(ctxB as never);
    assert.deepEqual(ctxB.replies, [DENIED]);
    assert.equal(calls.sendInput.length, 0);

    const ctxA = fakeCtx(USER_A, { match: `${a.id} do the thing` });
    await controller.sendCommand(ctxA as never);
    assert.deepEqual(calls.sendInput, [{ id: a.id, text: "do the thing" }]);
    assert.ok(ctxA.replies.some((r) => r.startsWith("✅ Sent")));
    // output was redacted before echoing
    assert.ok(!ctxA.replies.join("\n").includes("hunter2"));
  });

  it("/qoder forwards raw interactive commands, including slash commands Telegram would consume", async () => {
    const { db, controller, calls } = buildApp();
    const qoder = db.createSession({
      name: "qoder",
      project_id: null,
      agent_type: "qoder",
      cwd: "/tmp",
      owner_telegram_user_id: USER_A,
    });

    const owner = fakeCtx(USER_A, { match: `${qoder.id} /help` });
    await controller.qoderCommand(owner as never);
    assert.deepEqual(calls.sendInput, [{ id: qoder.id, text: "/help" }]);
    assert.ok(owner.replies.some((r) => r.startsWith("✅ Sent to Qoder session")));

    const foreign = fakeCtx(USER_B, { match: `${qoder.id} /status` });
    await controller.qoderCommand(foreign as never);
    assert.deepEqual(foreign.replies, [DENIED]);
    assert.equal(calls.sendInput.length, 1);
  });

  it("/history: foreign session denied; owner sees own messages", async () => {
    const { db, controller } = buildApp();
    const a = mkSession(db, USER_A);
    db.addMessage({ session_id: a.id, direction: "USER_TO_AGENT", content: "my private task" });
    const ctxB = fakeCtx(USER_B, { match: String(a.id) });
    await controller.historyCommand(ctxB as never);
    assert.deepEqual(ctxB.replies, [DENIED]);
    const ctxA = fakeCtx(USER_A, { match: String(a.id) });
    await controller.historyCommand(ctxA as never);
    assert.ok(ctxA.replies[0]?.includes("my private task"));
  });

  it("callbacks sess/act/git/logview/loglist/agentappr all deny non-owners", async () => {
    const { db, controller, calls } = buildApp();
    const a = mkSession(db, USER_A);
    const t = db.createTaskLog({ session_id: a.id, project_id: null, remote_path: "/x.log", task: null, status: "STARTED" });
    const data = [
      `sess:${a.id}`,
      `act:stop:${a.id}`,
      `act:logs:${a.id}`,
      `act:history:${a.id}`,
      `git:diff:${a.id}`,
      `logview:${t.id}`,
      `logtail:${t.id}`,
      `loglist:${a.id}`,
      `agentappr:${a.id}:yes`,
    ];
    for (const d of data) {
      const ctx = fakeCtx(USER_B, { data: d });
      await (controller as any).handleCallback(ctx);
      assert.deepEqual(ctx.replies, [DENIED], `callback ${d} must deny non-owner`);
    }
    assert.equal(calls.stop.length, 0);
    assert.equal(calls.sendInput.length, 0);
  });

  it("approval callbacks: B cannot resolve A's approval; A can; session-less is admin-only", async () => {
    const { db, controller, calls } = buildApp();
    const a = mkSession(db, USER_A);
    const appr = db.createApproval({ session_id: a.id, action_type: "git:push", payload: {} });
    const global = db.createApproval({ session_id: null, action_type: "system:restart", payload: {} });

    await (controller as any).handleCallback(fakeCtx(USER_B, { data: `appr:${appr.id}:yes` }));
    assert.deepEqual(calls.resolved, []);

    await (controller as any).handleCallback(fakeCtx(USER_B, { data: `appr:${global.id}:yes` }));
    assert.deepEqual(calls.resolved, []);

    await (controller as any).handleCallback(fakeCtx(USER_A, { data: `appr:${appr.id}:yes` }));
    assert.deepEqual(calls.resolved, [appr.id]);

    await (controller as any).handleCallback(fakeCtx(ADMIN, { data: `appr:${global.id}:no` }));
    assert.deepEqual(calls.resolved, [appr.id, global.id]);
  });

  it("/stop and /kill commands deny foreign sessions, owner passes", async () => {
    const { db, controller, calls } = buildApp();
    const a = mkSession(db, USER_A);

    const ctxB = fakeCtx(USER_B, { match: String(a.id) });
    await controller.stopCommand(ctxB as never);
    assert.deepEqual(ctxB.replies, [DENIED]);
    assert.equal(calls.stop.length, 0);

    const ctxB2 = fakeCtx(USER_B, { match: String(a.id) });
    await controller.killCommand(ctxB2 as never);
    assert.deepEqual(ctxB2.replies, [DENIED]);
    assert.equal(calls.stop.length, 0);

    await controller.stopCommand(fakeCtx(USER_A, { match: String(a.id) }) as never);
    assert.deepEqual(calls.stop, [a.id]);

    // admin may stop anyone's session
    await controller.killCommand(fakeCtx(ADMIN, { match: String(a.id) }) as never);
    assert.deepEqual(calls.stop, [a.id, a.id]);
  });

  it("plain-text chat mode: stale activeSession pointing at another user's session re-checks and denies", async () => {
    const { db, controller, calls } = buildApp();
    const a = mkSession(db, USER_A);
    const c = controller as unknown as { st(uid: number): { activeSession?: number } };
    c.st(USER_B).activeSession = a.id; // forged/stale state
    const ctx = fakeCtx(USER_B, { text: "ls" });
    await controller.textMessage(ctx as never);
    assert.deepEqual(ctx.replies, [DENIED]);
    assert.equal(calls.sendInput.length, 0);
    assert.equal(c.st(USER_B).activeSession, undefined);
  });

  it("wizard: project_id from callback is re-authorized at creation; owner is recorded", async () => {
    const { db, controller, calls } = buildApp();
    const proj = db.createProject("p", "/srv/p", null, USER_A, "private");

    // B hijacks the wizard with A's project id
    (controller as unknown as { st(n: number): { wizard?: unknown } }).st(USER_B).wizard = {
      step: "task",
      project_id: proj.id,
      agent: "shell",
    };
    const ctxB2 = fakeCtx(USER_B, { text: "task" });
    await (controller as any).finishWizard(ctxB2, "task");
    assert.deepEqual(ctxB2.replies, [DENIED]);
    assert.equal(calls.created.length, 0);

    // A creates normally → owner stored
    (controller as unknown as { st(n: number): { wizard?: unknown } }).st(USER_A).wizard = {
      step: "task",
      project_id: proj.id,
      agent: "shell",
    };
    const ctxA = fakeCtx(USER_A);
    await (controller as any).finishWizard(ctxA, "task");
    assert.deepEqual(calls.created, [{ owner: USER_A, project_id: proj.id }]);
  });

  it("proj: callback for a foreign private project is denied at selection time", async () => {
    const { db, controller } = buildApp();
    const proj = db.createProject("p", "/srv/p", null, USER_A, "private");
    const ctx = fakeCtx(USER_B, { data: `proj:${proj.id}` });
    await (controller as any).handleCallback(ctx);
    assert.deepEqual(ctx.replies, [DENIED]);
  });
});

describe("telegram layer: visibility scoping + admin gates", () => {
  it("/sessions shows A only their own; admin sees all with owner labels", async () => {
    const { db, controller } = buildApp();
    mkSession(db, USER_A, "alpha-session");
    mkSession(db, USER_B, "beta-session");
    mkSession(db, null, "legacy-session");

    const ctxA = fakeCtx(USER_A);
    await (controller as any).sessionsOverview(ctxA);
    const textA = ctxA.replies.join("\n");
    assert.ok(textA.includes("alpha-session"));
    assert.ok(!textA.includes("beta-session"));
    assert.ok(!textA.includes("legacy-session"));

    const ctxAdm = fakeCtx(ADMIN);
    await (controller as any).sessionsOverview(ctxAdm);
    const textAdm = ctxAdm.replies.join("\n");
    assert.ok(textAdm.includes("alpha-session"));
    assert.ok(textAdm.includes("beta-session"));
    assert.ok(textAdm.includes("legacy-session"));
    assert.ok(textAdm.includes(`owner ${USER_A}`));
    assert.ok(textAdm.includes("legacy · unowned"));
  });

  it("/hosts hides other users' private hosts", async () => {
    const { db, controller } = buildApp();
    db.createHost({ name: "host-a", host: "a.example", port: 22, username: "u", password_enc: "x", owner_telegram_user_id: USER_A });
    const ctxB = fakeCtx(USER_B);
    await (controller as any).hostsOverview(ctxB);
    assert.ok(!ctxB.replies.join("\n").includes("host-a"));
    const ctxAdm = fakeCtx(ADMIN);
    await (controller as any).hostsOverview(ctxAdm);
    assert.ok(ctxAdm.replies.join("\n").includes("host-a"));
  });

  it("admin-only callbacks (server/health/alerts/settings/processes) refuse normal users", async () => {
    const { controller } = buildApp();
    for (const nav of ["server", "health", "alerts", "settings", "processes"]) {
      const ctx = fakeCtx(USER_B, { data: `nav:${nav}` });
      await (controller as any).handleCallback(ctx);
      assert.ok(
        ctx.replies.some((r) => r.includes("restricted to administrators")),
        `nav:${nav} must be admin-only`,
      );
    }
  });

  it("/removeproject: owner deletes own; B and shared-visible users cannot; legacy is admin-only", async () => {
    const { db, controller } = buildApp();
    const projA = db.createProject("pa", "/srv/pa", null, USER_A);
    const legacy = db.createProject("old", "/srv/old");
    const shared = db.createProject("sh", "/srv/sh", null, ADMIN, "shared");

    // B cannot resolve A's private project at all
    const ctxB = fakeCtx(USER_B, { match: String(projA.id) });
    await controller.removeProjectCommand(ctxB as never);
    assert.deepEqual(ctxB.replies, [DENIED]);
    assert.ok(db.getProject(projA.id));

    // B sees the shared project but may not manage it
    const ctxShared = fakeCtx(USER_B, { match: String(shared.id) });
    await controller.removeProjectCommand(ctxShared as never);
    assert.deepEqual(ctxShared.replies, [DENIED]);
    assert.ok(db.getProject(shared.id));

    // legacy (NULL owner) invisible to normal users
    const ctxLegacy = fakeCtx(USER_A, { match: String(legacy.id) });
    await controller.removeProjectCommand(ctxLegacy as never);
    assert.deepEqual(ctxLegacy.replies, [DENIED]);

    // A removes their own
    const ctxA = fakeCtx(USER_A, { match: String(projA.id) });
    await controller.removeProjectCommand(ctxA as never);
    assert.ok(ctxA.replies.some((r) => r.includes("removed")));
    assert.equal(db.getProject(projA.id), undefined);

    // admin removes legacy + shared
    await controller.removeProjectCommand(fakeCtx(ADMIN, { match: String(legacy.id) }) as never);
    assert.equal(db.getProject(legacy.id), undefined);
    assert.equal(legacy.owner_telegram_user_id, null);
  });
});

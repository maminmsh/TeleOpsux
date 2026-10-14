import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DB } from "../src/db/database";
import { TelegramController } from "../src/telegram/bot";
import type { App } from "../src/core/container";
import { makeConfig, tempDbFile, tempDir } from "./helpers";

const ADMIN = 100;
const USER_A = 111;

interface NavCalls {
  ctxEdits: string[];
  apiEdits: string[];
  replies: string[];
  acks: number;
}

function buildTestHarness() {
  const config = makeConfig({
    allowed_users: [USER_A, ADMIN],
    admin_users: [ADMIN],
    webapp: { enabled: true, url: "https://t.me/app" },
  });
  const dir = tempDir("teleops-redesign-");
  const db = new DB(tempDbFile(dir));
  const calls: NavCalls = { ctxEdits: [], apiEdits: [], replies: [], acks: 0 };
  const mockHosts = new Map<number, any>();
  let nextHostId = 1;

  const app = {
    config,
    db,
    bus: { on() {}, emit() {} },
    logs: {
      system: { info() {}, warn() {}, error() {} },
      audit: { audit() {} },
      session: { sessionOutput() {} },
    },
    sessions: {
      remoteMode: false,
      capture: async () => "session output preview",
      currentHostId: null,
      tmuxTransport: null,
      stop: async () => {},
      resume: async () => {},
      sendKey: async () => {},
      reconcile: async () => ({ sessions: 0, active: 0 }),
      create: async (params: any) =>
        db.createSession({ ...params, agent_type: params.agent ?? "shell" }),
      start: async () => {},
    },
    hosts: {
      getHost: (id: number) => mockHosts.get(id) ?? db.getHost(id),
      testHost: async (id: number) => ({ ok: true, hostname: "remote-srv", user: "deploy", tmux: "tmux 3.3a" }),
      activateHostForUser: (uid: number, hid: number) => db.activateHostForUser(uid, hid),
    },
    adapters: { ids: () => ["shell", "qoder"], get: () => undefined },
    credentials: {
      status: () => "missing",
      hasCredential: () => false,
      revealForLaunch: () => null,
      containsStoredSecret: () => false,
      redactAll: (t: string) => t,
    },
    tracker: { modules: () => ["system", "ssh"], state: () => "ok", recent: () => [], count24h: () => 0, report() {} },
    serverMode: {
      connection: null,
      execOnHost: async (_hid: number, cmd: string) => {
        if (cmd === "test") return { code: 0, stdout: "", stderr: "" };
        if (cmd === "git") return { code: 0, stdout: "true", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      switchActiveHost: async () => {},
    },
    monitor: { metrics: async () => ({}), topProcesses: async () => [], fullReport: async () => null },
    git: {
      isRepo: async () => true,
      currentBranch: async () => "main",
    },
  } as unknown as App;

  const controller = new TelegramController(app);

  (controller as unknown as { bot: { api: Record<string, unknown> } }).bot.api.editMessageText =
    async (_chatId: number, _messageId: number, text: string) => {
      calls.apiEdits.push(text);
    };

  let seq = 5000;
  const tap = (uid: number, data: string) => ({
    from: { id: uid },
    chat: { id: 7000 + uid },
    callbackQuery: { data, id: "q", message: { chat: { id: 7000 + uid }, message_id: seq } },
    editMessageText: async (text: string) => {
      calls.ctxEdits.push(text);
      seq++;
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

  return { app, db, controller, calls, press, mockHosts };
}

describe("TeleOpsux Redesign Verification", () => {
  it("Requirement 2: /start renders EXACTLY 5 main control buttons", async () => {
    const { controller, db } = buildTestHarness();
    try {
      const menu = (controller as any).mainMenu(true);
      const buttons = menu.inline_keyboard.flat();

      assert.equal(buttons.length, 5, "Must have exactly 5 main buttons");
      const buttonTexts = buttons.map((b: any) => b.text);
      assert.ok(buttonTexts.some((t: string) => t.includes("سرورها")), "Includes سرورها");
      assert.ok(buttonTexts.some((t: string) => t.includes("پروژه‌ها")), "Includes پروژه‌ها");
      assert.ok(buttonTexts.some((t: string) => t.includes("سشن‌ها")), "Includes سشن‌ها");
      assert.ok(buttonTexts.some((t: string) => t.includes("لاگ‌ها")), "Includes لاگ‌ها");
      assert.ok(buttonTexts.some((t: string) => t.includes("تنظیمات")), "Includes تنظیمات");

      const callbacks = buttons.map((b: any) => b.callback_data);
      assert.deepEqual(callbacks, ["nav:hosts", "nav:projects", "nav:sessions", "nav:logs", "nav:settings"]);
    } finally {
      db.close();
    }
  });

  it("Requirement 2: Single-message in-place navigation and back history", async () => {
    const { press, calls, db } = buildTestHarness();
    try {
      await press(ADMIN, "menu:main");
      assert.equal(calls.ctxEdits.length, 1);
      assert.match(calls.ctxEdits[0]!, /AI COMMAND CENTER/);

      await press(ADMIN, "nav:hosts");
      assert.equal(calls.ctxEdits.length, 2);
      assert.match(calls.ctxEdits[1]!, /سرورهای من/);

      await press(ADMIN, "back");
      assert.equal(calls.ctxEdits.length, 3);
      assert.match(calls.ctxEdits[2]!, /AI COMMAND CENTER/);

      assert.equal(calls.replies.length, 0, "No new messages sent — in-place edit exclusively");
    } finally {
      db.close();
    }
  });

  it("Requirement 3: Server management details, test connection and safe deletion confirmation", async () => {
    const { db, press, calls } = buildTestHarness();
    try {
      const host = db.createHost({
        name: "AppServer",
        host: "10.0.0.1",
        port: 22,
        username: "deploy",
        password_enc: "enc",
        owner_telegram_user_id: ADMIN,
        visibility: "private",
      });

      // Details view
      await press(ADMIN, `hostdetail:${host.id}`);
      const detail = calls.ctxEdits[calls.ctxEdits.length - 1]!;
      assert.match(detail, /AppServer/);
      assert.match(detail, /10\.0\.0\.1:22/);

      // Test connection
      await press(ADMIN, `hosttest:${host.id}`);
      const test = calls.ctxEdits[calls.ctxEdits.length - 1]!;
      assert.match(test, /نتیجه آزمایش اتصال سرور/);
      assert.match(test, /اتصال SSH با موفقیت برقرار شد/);

      // Delete confirmation
      await press(ADMIN, `hostdelreq:${host.id}`);
      const delReq = calls.ctxEdits[calls.ctxEdits.length - 1]!;
      assert.match(delReq, /تأیید حذف سرور/);
      assert.match(delReq, /هیچ‌گونه فایل، پروژه، پوشه یا اطلاعاتی از سیستم مقصد لینوکس حذف نخواهد شد/);

      // Confirm delete: removes record from DB
      await press(ADMIN, `hostdel:${host.id}`);
      assert.equal(db.getHost(host.id), undefined);
    } finally {
      db.close();
    }
  });

  it("Requirement 4: Project management details, path verification, and safe deletion confirmation", async () => {
    const { db, press, calls } = buildTestHarness();
    try {
      const proj = db.createProject("MyApi", "/srv/my-api", null, ADMIN);

      // Project detail
      await press(ADMIN, `projdetail:${proj.id}`);
      const detail = calls.ctxEdits[calls.ctxEdits.length - 1]!;
      assert.match(detail, /MyApi/);
      assert.match(detail, /\/srv\/my-api/);

      // Project check
      await press(ADMIN, `projcheck:${proj.id}`);
      const check = calls.ctxEdits[calls.ctxEdits.length - 1]!;
      assert.match(check, /نتیجه بررسی مسیر و گیت پروژه/);

      // Delete confirmation
      await press(ADMIN, `projdelreq:${proj.id}`);
      const delReq = calls.ctxEdits[calls.ctxEdits.length - 1]!;
      assert.match(delReq, /تأیید حذف ثبت پروژه/);
      assert.match(delReq, /تمام فایل‌ها، پوشه‌ها و اطلاعات روی سرور کاملاً دست‌نخورده باقی می‌مانند/);

      // Confirm delete
      await press(ADMIN, `projdel:${proj.id}`);
      assert.equal(db.getProject(proj.id), undefined);
    } finally {
      db.close();
    }
  });

  it("Requirement 5: Session wizard steps from project to agent launch", async () => {
    const { db, press, calls } = buildTestHarness();
    try {
      const proj = db.createProject("WorkerProject", "/srv/worker", null, ADMIN);

      // Step 1: select project
      await press(ADMIN, "sessnew:start");
      const step1 = calls.ctxEdits[calls.ctxEdits.length - 1]!;
      assert.match(step1, /انتخاب پروژه/);

      // Step 2: select agent mode
      await press(ADMIN, `sessnew:prj:0:${proj.id}`);
      const step2 = calls.ctxEdits[calls.ctxEdits.length - 1]!;
      assert.match(step2, /نوع سشن/);

      // Step 3: launch shell
      await press(ADMIN, `sessnew:mode:${proj.id}:shell`);
      const sessions = db.listSessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]!.project_id, proj.id);
      assert.equal(sessions[0]!.agent_type, "shell");
    } finally {
      db.close();
    }
  });

  it("Requirement 6: Mini App page contains mobile helper keys and resize endpoints", async () => {
    const { MINI_APP_HTML } = await import("../src/web/mini-app-page");

    // Helper keys in Session view
    assert.match(MINI_APP_HTML, /id="vcc"/, "Virtual Ctrl+C key");
    assert.match(MINI_APP_HTML, /id="vtab"/, "Virtual Tab key");
    assert.match(MINI_APP_HTML, /id="vesc"/, "Virtual Esc key");
    assert.match(MINI_APP_HTML, /id="vup"/, "Virtual Up key");
    assert.match(MINI_APP_HTML, /id="vdown"/, "Virtual Down key");

    // Helper keys in Terminal view
    assert.match(MINI_APP_HTML, /id="ttab"/, "Terminal Tab key");
    assert.match(MINI_APP_HTML, /id="tesc"/, "Terminal Esc key");

    // Resize endpoints
    assert.match(MINI_APP_HTML, /\/api\/session\/resize/, "Calls session resize API");
    assert.match(MINI_APP_HTML, /\/api\/terminal\/resize/, "Calls terminal resize API");
  });
});

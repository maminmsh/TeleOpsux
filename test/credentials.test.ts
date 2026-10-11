import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DB } from "../src/db/database";
import { EventBus } from "../src/core/event-bus";
import { LogHub } from "../src/logger/logger";
import { AdapterRegistry } from "../src/adapters/registry";
import { QoderAdapter } from "../src/adapters/qoder-adapter";
import { Tmux } from "../src/session/tmux";
import { SessionManager } from "../src/session/session-manager";
import type { ProjectFiles } from "../src/session/project-files";
import { SecretBox } from "../src/shared/secret-box";
import {
  CREDENTIAL_IN_CHAT_MESSAGE,
  CREDENTIAL_REQUIRED_MESSAGE,
  CredentialRequiredError,
  CredentialService,
} from "../src/credentials/credential-service";
import { ProvisionServer } from "../src/credentials/provision-server";
import { TelegramController } from "../src/telegram/bot";
import type { ExecOptions, ExecResult, ExecRunner } from "../src/exec/exec-runner";
import type { App } from "../src/core/container";
import { makeConfig, tempDbFile, tempDir } from "./helpers";

const USER_A = 111;
const USER_B = 222;
const ADMIN = 100;
const KEY_A = "qoder-key-AAAA-0123456789abcdef";
const KEY_B = "qoder-key-BBBB-0123456789abcdef";

function ok(stdout = ""): ExecResult {
  return { code: 0, stdout, stderr: "" };
}

/**
 * Records EVERY command the session host would see (argv lines and shell
 * scripts) and every stdin payload, plus a fake filesystem for the staged
 * credential file. Nothing here can leak a key without showing up in `visible`.
 */
class FakeRunner implements ExecRunner {
  readonly kind = "local" as const;
  sessions = new Set<string>();
  pane = new Map<string, string>();
  files = new Map<string, string>();
  visible: string[] = [];
  stdinWrites: string[] = [];

  async exec(cmd: string, args: string[]): Promise<ExecResult> {
    this.visible.push([cmd, ...args].join(" "));
    if (cmd !== "tmux") return ok();
    const flag = (name: string): string => args[args.indexOf(name) + 1] ?? "";
    switch (args[0]) {
      case "-V":
        return ok("tmux 3.4");
      case "ls":
        return ok([...this.sessions].join("\n"));
      case "new-session":
        this.sessions.add(flag("-s"));
        this.pane.set(flag("-s"), "");
        return ok();
      case "send-keys": {
        const target = flag("-t");
        if (args.includes("-l"))
          this.pane.set(target, (this.pane.get(target) ?? "") + flag("-l") + "\n");
        return ok();
      }
      case "display-message":
        return ok("4242");
      case "capture-pane":
        return ok(this.pane.get(flag("-t")) ?? "");
      case "kill-session":
        this.sessions.delete(flag("-t"));
        return ok();
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

  /** The value a pane's shell would export, by replaying `$(cat FILE)` + `rm -f`. */
  injectedEnv(target: string): { file: string; value: string | undefined } {
    const launch = (this.pane.get(target) ?? "").trim();
    const m = launch.match(/="\$\(cat "([^"]+)"\)"; rm -f "\1";/);
    assert.ok(m, `launch command does not read+delete a staged file: ${launch}`);
    const file = m[1]!;
    const value = this.files.get(file);
    this.files.delete(file); // the pane deletes the file right after reading
    return { file, value };
  }
}

function build() {
  const config = makeConfig({
    allowed_users: [USER_A, USER_B, ADMIN],
    admin_users: [ADMIN],
  });
  const dir = tempDir("teleops-cred-");
  const db = new DB(tempDbFile(dir));
  const bus = new EventBus(db);
  const logs = new LogHub(path.join(dir, "logs"));
  const keyFile = path.join(dir, "teleops.key");
  const creds = new CredentialService(db, new SecretBox(keyFile));
  const runner = new FakeRunner();
  const tmux = new Tmux(config.sessions.tmux_prefix, runner);
  const adapters = new AdapterRegistry(config.agents);
  const sessions = new SessionManager(db, bus, tmux, adapters, logs, config);
  sessions.setCredentials(creds);

  // Attach a host so BOTH the tmux argv path and the credential staging path
  // run through the FakeRunner — nothing touches the real filesystem.
  const host = db.createHost({
    name: "h1",
    host: "h1.example",
    port: 22,
    username: "ops",
    password_enc: "iv:tag:data",
    owner_telegram_user_id: null,
    visibility: "shared",
  });
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
  const project = (owner: number) =>
    db.createProject(`p${owner}`, `/srv/p${owner}`, host.id, owner, "private");
  return { config, db, bus, logs, creds, runner, sessions, adapters, dir, host, project };
}

function target(prefix: string, id: number): string {
  return `${prefix}-${id}`;
}

describe("per-user Qoder credentials: storage", () => {
  it("stores the key encrypted — no plaintext anywhere in the database file", () => {
    const { db, creds, dir } = build();
    creds.save(USER_A, KEY_A);
    assert.equal(creds.status(USER_A), "configured");
    const row = db.getQoderCredential(USER_A)!;
    assert.ok(row.key_enc.includes(":")); // iv:tag:ciphertext
    assert.ok(!row.key_enc.includes(KEY_A));
    const raw = fs.readFileSync(tempDbFile(dir));
    assert.ok(!raw.includes(Buffer.from(KEY_A)));
    // status surfaces never carry key material
    const [status] = db.listCredentialStatuses();
    assert.deepEqual(Object.keys(status!).sort(), ["status", "telegram_user_id", "updated_at"]);
  });

  it("rejects malformed values and never stores a key shorter/longer than the bounds", () => {
    const { creds } = build();
    assert.throws(() => creds.save(USER_A, "short"));
    assert.throws(() => creds.save(USER_A, "x".repeat(600)));
    assert.throws(() => creds.save(USER_A, `bad\nkey`));
    assert.equal(creds.status(USER_A), "missing");
  });

  it("an undecryptable row becomes invalid and blocks launch (fail closed)", () => {
    const { db, creds } = build();
    creds.save(USER_A, KEY_A);
    db.upsertQoderCredential(USER_A, "not:a:valid:blob");
    assert.equal(creds.revealForLaunch(USER_A), null);
    assert.equal(creds.status(USER_A), "invalid");
    assert.equal(creds.hasCredential(USER_A), false);
  });

  it("deleting one user's credential leaves other users untouched", () => {
    const { creds } = build();
    creds.save(USER_A, KEY_A);
    creds.save(USER_B, KEY_B);
    creds.remove(USER_A);
    assert.equal(creds.status(USER_A), "missing");
    assert.equal(creds.status(USER_B), "configured");
    assert.equal(creds.revealForLaunch(USER_B), KEY_B);
  });
});

describe("per-user Qoder credentials: session isolation", () => {
  it("a Qoder session receives ONLY its owner's credential", async () => {
    const { creds, runner, sessions, config, project } = build();
    creds.save(USER_A, KEY_A);
    creds.save(USER_B, KEY_B);

    const a = await sessions.create({
      name: "a-qoder",
      project_id: project(USER_A).id,
      agent: "qoder",
      cwd: "/srv/a",
      owner_telegram_user_id: USER_A,
    });
    const mark = runner.visible.length;
    await sessions.start(a.id);

    const injected = runner.injectedEnv(target(config.sessions.tmux_prefix, a.id));
    assert.equal(injected.value, KEY_A);
    assert.ok(injected.file.includes(`teleops-session-${a.id}.key`));
    // the staged file is gone once the pane has read it
    assert.equal(runner.files.has(injected.file), false);
    // B's key never enters A's launch: not in any command, script or stdin
    const commands = runner.visible.slice(mark).join("\n");
    assert.ok(!commands.includes(KEY_B));
    assert.ok(!commands.includes(KEY_A), "the key must never appear in a command line");
    // A's key travels only through the stdin channel, exactly once
    assert.equal(runner.stdinWrites.filter((s) => s === KEY_A).length, 1);
    assert.equal(runner.stdinWrites.includes(KEY_B), false);
  });

  it("a second user's session on the same host gets only their own key", async () => {
    const { creds, runner, sessions, config, project } = build();
    creds.save(USER_A, KEY_A);
    creds.save(USER_B, KEY_B);
    const a = await sessions.create({
      name: "a",
      project_id: project(USER_A).id,
      agent: "qoder",
      cwd: "/srv/a",
      owner_telegram_user_id: USER_A,
    });
    await sessions.start(a.id);
    const b = await sessions.create({
      name: "b",
      project_id: project(USER_B).id,
      agent: "qoder",
      cwd: "/srv/b",
      owner_telegram_user_id: USER_B,
    });
    await sessions.start(b.id);

    const prefix = config.sessions.tmux_prefix;
    assert.equal(runner.injectedEnv(target(prefix, a.id)).value, KEY_A);
    assert.equal(runner.injectedEnv(target(prefix, b.id)).value, KEY_B);
    // nothing in the whole transcript of A's pane contains B's key (or vice versa)
    assert.ok(!runner.pane.get(target(prefix, a.id))!.includes(KEY_B));
    assert.ok(!runner.pane.get(target(prefix, b.id))!.includes(KEY_A));
  });

  it("a user without their own credential cannot create or start a Qoder session", async () => {
    const { creds, db, runner, sessions, project } = build();
    creds.save(USER_A, KEY_A); // A is provisioned; B is not
    const bProject = project(USER_B);

    await assert.rejects(
      sessions.create({
        name: "b-qoder",
        project_id: bProject.id,
        agent: "qoder",
        cwd: "/srv/b",
        owner_telegram_user_id: USER_B,
      }),
      (e: unknown) =>
        e instanceof CredentialRequiredError &&
        e.message === CREDENTIAL_REQUIRED_MESSAGE,
    );
    assert.equal(db.listSessions().length, 0, "no session row may be created");

    // an existing (e.g. legacy, unowned) row must not start either
    const legacy = db.createSession({
      name: "legacy",
      project_id: null,
      agent_type: "qoder",
      cwd: "/srv/b",
      owner_telegram_user_id: null,
    });
    await assert.rejects(sessions.start(legacy.id), /not configured for your account/);
    assert.equal(runner.sessions.size, 0, "tmux must never be invoked");

    // agents without a credential requirement are unaffected
    const shell = await sessions.create({
      name: "b-shell",
      project_id: bProject.id,
      agent: "shell",
      cwd: "/srv/b",
      owner_telegram_user_id: USER_B,
    });
    assert.ok(shell.id > 0);
  });

  it("an invalid credential also blocks launch (only 'configured' may run)", async () => {
    const { creds, db, runner, sessions } = build();
    creds.save(USER_A, KEY_A);
    creds.markInvalid(USER_A);
    const s = db.createSession({
      name: "a",
      project_id: null,
      agent_type: "qoder",
      cwd: "/srv/a",
      owner_telegram_user_id: USER_A,
    });
    await assert.rejects(sessions.start(s.id), CredentialRequiredError);
    assert.equal(runner.sessions.size, 0);
  });

  it("never falls back to a server-wide key: the pane unsets an inherited one", async () => {
    const { creds, runner, sessions, config, project } = build();
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "SERVER-SHARED-KEY";
    process.env.QODER_API_KEY = "LEGACY-SHARED-KEY";
    try {
      // A shared key on the server host must NOT let an unprovisioned user run.
      await assert.rejects(
        sessions.create({
          name: "b",
          project_id: project(USER_B).id,
          agent: "qoder",
          cwd: "/srv/b",
          owner_telegram_user_id: USER_B,
        }),
        CredentialRequiredError,
      );
      creds.save(USER_A, KEY_A);
      const a = await sessions.create({
        name: "a",
        project_id: project(USER_A).id,
        agent: "qoder",
        cwd: "/srv/a",
        owner_telegram_user_id: USER_A,
      });
      await sessions.start(a.id);
      const launch = runner.pane.get(target(config.sessions.tmux_prefix, a.id))!;
      assert.ok(
        launch.includes("unset QODER_PERSONAL_ACCESS_TOKEN QODER_API_KEY"),
        "current and legacy inherited keys must be cleared",
      );
      assert.ok(!launch.includes("SERVER-SHARED-KEY"));
      assert.ok(!launch.includes("LEGACY-SHARED-KEY"));
      assert.ok(!runner.injectedEnv(target(config.sessions.tmux_prefix, a.id)).value?.includes("SERVER"));
    } finally {
      delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
      delete process.env.QODER_API_KEY;
    }
  });

  it("stop() removes a staged credential file left on the host", async () => {
    const { creds, runner, sessions, project } = build();
    creds.save(USER_A, KEY_A);
    const a = await sessions.create({
      name: "a",
      project_id: project(USER_A).id,
      agent: "qoder",
      cwd: "/srv/a",
      owner_telegram_user_id: USER_A,
    });
    await sessions.start(a.id);
    // the fake pane never executes, so the staged file is still on disk
    assert.equal(runner.files.size, 1);
    assert.ok([...runner.files.values()].includes(KEY_A));
    await sessions.stop(a.id);
    assert.equal(runner.files.size, 0, "staged key file must be removed on stop");
  });
});

describe("per-user Qoder credentials: output never leaks", () => {
  it("a key typed into chat is refused and never persisted", async () => {
    const { creds, db, sessions, project } = build();
    creds.save(USER_A, KEY_A);
    creds.save(USER_B, KEY_B);
    const s = await sessions.create({
      name: "a",
      project_id: project(USER_A).id,
      agent: "qoder",
      cwd: "/srv/a",
      owner_telegram_user_id: USER_A,
    });
    await assert.rejects(
      sessions.sendInput(s.id, `here is my key ${KEY_A}`),
      (e: unknown) => (e as Error).message === CREDENTIAL_IN_CHAT_MESSAGE,
    );
    await assert.rejects(
      sessions.sendInput(s.id, `borrowed ${KEY_B}`),
      (e: unknown) => (e as Error).message === CREDENTIAL_IN_CHAT_MESSAGE,
    );
    const rows = db.listMessages(s.id);
    assert.ok(!JSON.stringify(rows).includes(KEY_A));
    assert.ok(!JSON.stringify(rows).includes(KEY_B));
  });

  it("redactAll scrubs every stored key out of agent output", () => {
    const { creds } = build();
    creds.save(USER_A, KEY_A);
    creds.save(USER_B, KEY_B);
    const noisy = `export QODER_PERSONAL_ACCESS_TOKEN=${KEY_A}\nthen ${KEY_B} again ${KEY_A}`;
    const clean = creds.redactAll(noisy);
    assert.ok(!clean.includes(KEY_A));
    assert.ok(!clean.includes(KEY_B));
    assert.ok(clean.includes("***REDACTED***"));
  });

  it("auth failures are classified as credential problems without echoing the value", () => {
    const adapter = new QoderAdapter();
    assert.equal(adapter.detectCredentialError("qoder: invalid API key"), true);
    assert.equal(adapter.detectCredentialError("Error: authentication failed (401)"), true);
    assert.equal(adapter.detectCredentialError("npm install finished, 3 tests passed"), false);
    assert.ok(!adapter.detectCredentialError(`key ${KEY_A} rejected`)); // never surfaces it
  });
});

describe("per-user Qoder credentials: provisioning link", () => {
  function buildProvision(port = 0) {
    const { creds, db } = build();
    const server = new ProvisionServer(creds, {
      enabled: true,
      host: "127.0.0.1",
      port,
      base_url: "",
    });
    return { creds, db, server };
  }

  it("a single-use link stores the key and the token cannot be replayed", async () => {
    const { creds, server } = buildProvision();
    await server.start();
    try {
      const token = creds.createProvisionToken(USER_A);
      const url = server.linkFor(token);
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/qoder-key\/[0-9a-f]{48}$/);

      const form = await (await fetch(url)).text();
      assert.ok(form.includes('type="password"'));
      assert.ok(!form.includes(token), "the page must not echo the token");

      const saved = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `api_key=${encodeURIComponent(KEY_A)}`,
      });
      assert.equal(saved.status, 200);
      assert.equal(creds.status(USER_A), "configured");
      assert.equal(creds.revealForLaunch(USER_A), KEY_A);

      const replay = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `api_key=${encodeURIComponent(KEY_B)}`,
      });
      assert.equal(replay.status, 400);
      assert.equal(creds.status(USER_B), "missing");
    } finally {
      server.stop();
    }
  });

  it("an expired link is refused", async () => {
    const { creds, db, server } = buildProvision();
    await server.start();
    try {
      const token = creds.createProvisionToken(USER_A);
      db
        .raw()
        .prepare("UPDATE credential_grants SET expires_at = datetime('now','-1 hour')")
        .run();
      const res = await fetch(server.linkFor(token), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `api_key=${encodeURIComponent(KEY_A)}`,
      });
      assert.equal(res.status, 400);
      assert.equal(creds.status(USER_A), "missing");
    } finally {
      server.stop();
    }
  });

  it("refuses to serve keys over plain HTTP on a non-loopback bind", async () => {
    const { creds } = build();
    const exposed = new ProvisionServer(creds, {
      enabled: true,
      host: "0.0.0.0",
      port: 8799,
      base_url: "",
    });
    await assert.rejects(exposed.start(), /https/);
    const proxied = new ProvisionServer(creds, {
      enabled: true,
      host: "0.0.0.0",
      port: 8799,
      base_url: "https://teleops.example.com",
    });
    assert.equal(proxied.linkFor("a".repeat(48)), "https://teleops.example.com/qoder-key/" + "a".repeat(48));
  });
});

describe("per-user Qoder credentials: Telegram surface", () => {
  interface Ctx {
    from: { id: number };
    chat: { id: number };
    callbackQuery?: { data: string };
    reply(text: string): Promise<{ message_id: number }>;
    replies: string[];
  }

  function fakeCtx(userId: number, data?: string): Ctx {
    const replies: string[] = [];
    return {
      from: { id: userId },
      chat: { id: 1000 + userId },
      callbackQuery: data ? { data } : undefined,
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 1 };
      },
      replies,
    };
  }

  function buildHarness(
    provisionFactory?: (creds: CredentialService) => ProvisionServer,
  ) {
    const config = makeConfig({
      allowed_users: [USER_A, USER_B, ADMIN],
      admin_users: [ADMIN],
    });
    const dir = tempDir("teleops-cred-bot-");
    const db = new DB(tempDbFile(dir));
    const creds = new CredentialService(db, new SecretBox(path.join(dir, "teleops.key")));
    const app = {
      config,
      db,
      credentials: creds,
      provision: provisionFactory ? provisionFactory(creds) : null,
    } as unknown as App;
    const controller = new TelegramController(app) as unknown as {
      qoderKeyCommand(ctx: Ctx): Promise<void>;
      handleCallback(ctx: Ctx): Promise<void>;
      requireAdmin(ctx: Ctx): Promise<boolean>;
      credentialsStatusText(): string;
    };
    return { db, creds, controller };
  }

  it("/qoderkey hands out a one-time link and shows status only — never the value", async () => {
    const { creds, controller } = buildHarness((c) => new ProvisionServer(c, {
      enabled: true,
      host: "127.0.0.1",
      port: 8717,
      base_url: "",
    }));
    creds.save(USER_A, KEY_A);
    const ctx = fakeCtx(USER_A);
    await controller.qoderKeyCommand(ctx);
    const text = ctx.replies.join("\n");
    assert.ok(text.includes("Status: configured"));
    assert.match(text, /http:\/\/127\.0\.0\.1:8717\/qoder-key\/[0-9a-f]{48}/);
    assert.ok(!text.includes(KEY_A), "the reply must never contain the key");
  });

  it("/qoderkey with provisioning disabled fails closed instead of asking for a key in chat", async () => {
    const { controller } = buildHarness();
    const ctx = fakeCtx(USER_B);
    await controller.qoderKeyCommand(ctx);
    const text = ctx.replies.join("\n");
    assert.ok(text.includes("Status: missing"));
    assert.ok(text.includes("disabled"));
    assert.ok(!/paste it here|send me the key/i.test(text));
  });

  it("deletion needs a confirmed second step and only removes the caller's own key", async () => {
    const { creds, controller } = buildHarness();
    creds.save(USER_A, KEY_A);
    creds.save(USER_B, KEY_B);

    // untrusted callback data alone must not delete anything
    const direct = fakeCtx(USER_A, "keydel:yes");
    await controller.handleCallback(direct);
    assert.equal(creds.status(USER_A), "configured");

    const ask = fakeCtx(USER_A, "keydel");
    await controller.handleCallback(ask);
    assert.ok(ask.replies.join("\n").includes("Delete your Qoder credential"));

    const confirm = fakeCtx(USER_A, "keydel:yes");
    await controller.handleCallback(confirm);
    assert.equal(creds.status(USER_A), "missing");
    assert.equal(creds.status(USER_B), "configured");
  });

  it("the admin listing is admin-only and exposes statuses, not values", async () => {
    const { creds, controller } = buildHarness();
    creds.save(USER_A, KEY_A);
    const text = controller.credentialsStatusText();
    assert.ok(text.includes(String(USER_A)) && text.includes("configured"));
    assert.ok(!text.includes(KEY_A));

    const asUser = fakeCtx(USER_A);
    assert.equal(await controller.requireAdmin(asUser), false);
    assert.ok(asUser.replies.join("").includes("administrators"));
    const asAdmin = fakeCtx(ADMIN);
    assert.equal(await controller.requireAdmin(asAdmin), true);
  });
});

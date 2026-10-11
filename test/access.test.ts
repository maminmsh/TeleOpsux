import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DB } from "../src/db/database";
import type { Config } from "../src/config/config";
import {
  DENY_MESSAGE,
  canManageProject,
  effectiveActiveHostId,
  isAdminUser,
  isAllowedUser,
  redactSecrets,
  resolveApproval,
  resolveHost,
  resolveProject,
  resolveSession,
  resolveTaskLog,
} from "../src/auth/access";
import { makeConfig, tempDbFile } from "./helpers";

const ADMIN = 100;
const USER_A = 111;
const USER_B = 222;
const STRANGER = 999;

function appWith(security: Partial<Config["security"]> = {}) {
  const config = makeConfig(security);
  const db = new DB(tempDbFile());
  return { db, config, ctx: { db, config } };
}

describe("roles", () => {
  it("rejects users outside both lists", () => {
    const { ctx } = appWith({ allowed_users: [USER_A], admin_users: [ADMIN] });
    assert.equal(isAllowedUser(ctx, STRANGER), false);
    assert.equal(isAdminUser(ctx, STRANGER), false);
    assert.equal(isAllowedUser(ctx, undefined), false);
  });

  it("normal allowed user is not admin when admin_users is set", () => {
    const { ctx } = appWith({ allowed_users: [USER_A, ADMIN], admin_users: [ADMIN] });
    assert.equal(isAdminUser(ctx, USER_A), false);
    assert.equal(isAdminUser(ctx, ADMIN), true);
  });

  it("legacy config without admin_users keeps old behaviour (all allowed users are admins)", () => {
    const { ctx } = appWith({ allowed_users: [USER_A, USER_B] });
    assert.equal(ctx.config.security.admin_users, undefined);
    assert.equal(isAdminUser(ctx, USER_A), true);
    assert.equal(isAdminUser(ctx, STRANGER), false);
  });

  it("empty admin_users list means strictly no admins among normal users", () => {
    const { ctx } = appWith({ allowed_users: [USER_A], admin_users: [] });
    assert.equal(isAdminUser(ctx, USER_A), false);
    assert.equal(isAllowedUser(ctx, USER_A), true);
  });
});

describe("session ownership", () => {
  it("normal user sees only their own session; admin sees all with owners", () => {
    const { ctx, db } = appWith({ allowed_users: [USER_A, USER_B, ADMIN], admin_users: [ADMIN] });
    const a = db.createSession({ name: "a", project_id: null, agent_type: "shell", cwd: "/tmp", owner_telegram_user_id: USER_A });
    db.createSession({ name: "b", project_id: null, agent_type: "shell", cwd: "/tmp", owner_telegram_user_id: USER_B });

    assert.ok(resolveSession(ctx, USER_A, a.id));
    assert.equal(resolveSession(ctx, USER_B, a.id), null);
    assert.equal(resolveSession(ctx, STRANGER, a.id), null);
    assert.equal(db.listSessionsForOwner(USER_A).length, 1);
    assert.equal(db.listSessionsForOwner(USER_B).length, 1);
    assert.equal(db.listSessionsForOwner(USER_A)[0]!.name, "a");
  });

  it("legacy NULL-owner sessions are admin-only", () => {
    const { ctx, db } = appWith({ allowed_users: [USER_A, ADMIN], admin_users: [ADMIN] });
    const legacy = db.createSession({ name: "old", project_id: null, agent_type: "shell", cwd: "/tmp" });
    assert.equal(legacy.owner_telegram_user_id, null);
    assert.equal(resolveSession(ctx, USER_A, legacy.id), null);
    assert.ok(resolveSession(ctx, ADMIN, legacy.id));
    assert.equal(db.listSessionsForOwner(USER_A).length, 0);
  });

  it("guessing ids never works: unknown id and foreign id give the SAME null", () => {
    const { ctx, db } = appWith({ allowed_users: [USER_A, USER_B, ADMIN], admin_users: [ADMIN] });
    const a = db.createSession({ name: "a", project_id: null, agent_type: "shell", cwd: "/tmp", owner_telegram_user_id: USER_A });
    assert.equal(resolveSession(ctx, USER_B, a.id), null);
    assert.equal(resolveSession(ctx, USER_B, 999999), null);
    assert.equal(DENY_MESSAGE, "⛔ You do not have access to this resource.");
  });
});

describe("project + host ownership", () => {
  it("shared resources are visible to all allowed users but only admin can manage them", () => {
    const { ctx, db } = appWith({ allowed_users: [USER_A, ADMIN], admin_users: [ADMIN] });
    db.createHost({ name: "h", host: "h", port: 22, username: "u", password_enc: "x", owner_telegram_user_id: ADMIN });
    const shared = db.createProject("shared", "/srv/shared", null, null, "shared");
    const privA = db.createProject("a-proj", "/srv/a", null, USER_A);

    assert.ok(resolveProject(ctx, USER_A, shared.id));
    assert.equal(canManageProject(ctx, USER_A, shared), false);
    assert.equal(canManageProject(ctx, ADMIN, shared), true);
    assert.ok(resolveProject(ctx, USER_A, privA.id));
    assert.equal(resolveProject(ctx, ADMIN, privA.id)?.id, privA.id);
    const mine = db.listProjectsForOwner(USER_A).map((p) => p.id);
    assert.deepEqual(mine.sort(), [shared.id, privA.id].sort());
  });

  it("normal users cannot see or resolve another user's private host", () => {
    const { ctx, db } = appWith({ allowed_users: [USER_A, USER_B, ADMIN], admin_users: [ADMIN] });
    const hostA = db.createHost({ name: "a-host", host: "a", port: 22, username: "u", password_enc: "x", owner_telegram_user_id: USER_A });
    assert.ok(resolveHost(ctx, USER_A, hostA.id));
    assert.equal(resolveHost(ctx, USER_B, hostA.id), null);
    assert.ok(resolveHost(ctx, ADMIN, hostA.id));
    assert.equal(db.listHostsForOwner(USER_B).length, 0);
  });

  it("per-user active host: B switching does not affect A, and A cannot target B's private host", () => {
    const { ctx, db } = appWith({ allowed_users: [USER_A, USER_B, ADMIN], admin_users: [ADMIN] });
    const hostA = db.createHost({ name: "a-host", host: "a", port: 22, username: "u", password_enc: "x", owner_telegram_user_id: USER_A });
    const hostB = db.createHost({ name: "b-host", host: "b", port: 22, username: "u", password_enc: "x", owner_telegram_user_id: USER_B });
    db.setActiveHost(hostB.id); // global transport now follows B's host

    // B owns the global host → resolves to it
    assert.equal(effectiveActiveHostId(ctx, USER_B), hostB.id);
    // A must not be dragged onto B's host
    assert.equal(effectiveActiveHostId(ctx, USER_A), null);
    // A picks their own → unaffected by B
    db.setUserActiveHost(USER_A, hostA.id);
    assert.equal(effectiveActiveHostId(ctx, USER_A), hostA.id);
    // a forged pointer to someone else's private host is ignored
    db.setUserActiveHost(USER_A, hostB.id);
    assert.equal(effectiveActiveHostId(ctx, USER_A), null);
    // admin sees the global active host
    assert.equal(effectiveActiveHostId(ctx, ADMIN), hostB.id);
  });
});

describe("logs, approvals, redaction", () => {
  it("task logs of another user's session are unresolvable", () => {
    const { ctx, db } = appWith({ allowed_users: [USER_A, USER_B, ADMIN], admin_users: [ADMIN] });
    const s = db.createSession({ name: "a", project_id: null, agent_type: "shell", cwd: "/tmp", owner_telegram_user_id: USER_A });
    const t = db.createTaskLog({ session_id: s.id, project_id: null, remote_path: "/tmp/x.log", task: null, status: "STARTED" });
    assert.ok(resolveTaskLog(ctx, USER_A, t.id));
    assert.equal(resolveTaskLog(ctx, USER_B, t.id), null);
    assert.equal(db.listTaskLogsForOwner(USER_B, 10).length, 0);
    assert.equal(db.listTaskLogsForOwner(USER_A, 10).length, 1);
  });

  it("approvals follow session ownership; session-less approvals are admin-only", () => {
    const { ctx, db } = appWith({ allowed_users: [USER_A, USER_B, ADMIN], admin_users: [ADMIN] });
    const s = db.createSession({ name: "a", project_id: null, agent_type: "shell", cwd: "/tmp", owner_telegram_user_id: USER_A });
    const a1 = db.createApproval({ session_id: s.id, action_type: "git:push", payload: {} });
    const a2 = db.createApproval({ session_id: null, action_type: "system:restart", payload: {} });
    assert.ok(resolveApproval(ctx, USER_A, a1.id));
    assert.equal(resolveApproval(ctx, USER_B, a1.id), null);
    assert.equal(resolveApproval(ctx, USER_B, a2.id), null);
    assert.ok(resolveApproval(ctx, ADMIN, a2.id));
  });

  it("redactSecrets masks credential-looking lines", () => {
    const out = redactSecrets("ok line\npassword: s3cret\nAPI_KEY=abc123");
    assert.ok(!out.includes("s3cret"));
    assert.ok(!out.includes("abc123"));
  });
});

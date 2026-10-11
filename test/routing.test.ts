import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DB } from "../src/db/database";
import { adminChatIds, liveOutputTarget, notificationChatIds } from "../src/notify/routing";
import type { DomainEvent } from "../src/shared/types";
import { makeConfig, tempDbFile } from "./helpers";

const ADMIN = 100;
const USER_A = 111;
const USER_B = 222;

function setup(security: Partial<ReturnType<typeof makeConfig>["security"]> = {}) {
  const config = makeConfig({
    allowed_users: [USER_A, USER_B, ADMIN],
    admin_users: [ADMIN],
    ...security,
  });
  const db = new DB(tempDbFile());
  db.upsertUserChat(USER_A, 1000 + USER_A);
  db.upsertUserChat(USER_B, 1000 + USER_B);
  db.upsertUserChat(ADMIN, 1000 + ADMIN);
  const ctx = { db, config };
  const mk = (owner: number | null) =>
    db.createSession({ name: "s", project_id: null, agent_type: "shell", cwd: "/tmp", owner_telegram_user_id: owner });
  return { db, config, ctx, mk };
}

describe("notification routing", () => {
  it("session events go to the session owner's chat only", () => {
    const { ctx, mk } = setup();
    const a = mk(USER_A);
    const event: DomainEvent = { type: "SESSION_FINISHED", session_id: a.id, created_at: "" };
    assert.deepEqual(notificationChatIds(ctx, event), [1000 + USER_A]);
  });

  it("user B interacting afterwards does NOT redirect A's notifications", () => {
    const { ctx, db, mk } = setup();
    const a = mk(USER_A);
    const event: DomainEvent = { type: "PROCESS_CRASHED", session_id: a.id, created_at: "" };
    // B starts talking to the bot — this used to overwrite the global primaryChatId
    db.upsertUserChat(USER_B, 2000);
    assert.deepEqual(notificationChatIds(ctx, event), [1000 + USER_A]);
  });

  it("admin_receive_all_notifications copies events to admins too", () => {
    const { ctx, mk } = setup({ admin_receive_all_notifications: true });
    const a = mk(USER_A);
    const ids = notificationChatIds(ctx, { type: "SESSION_FINISHED", session_id: a.id, created_at: "" });
    assert.deepEqual(new Set(ids), new Set([1000 + USER_A, 1000 + ADMIN]));
  });

  it("legacy unowned sessions notify admins, never random users", () => {
    const { ctx, mk } = setup();
    const legacy = mk(null);
    const ids = notificationChatIds(ctx, { type: "SESSION_FINISHED", session_id: legacy.id, created_at: "" });
    assert.deepEqual(ids, adminChatIds(ctx));
    assert.ok(!ids.includes(1000 + USER_A));
  });

  it("non-session events (server alerts) go to admins only", () => {
    const { ctx } = setup();
    const ids = notificationChatIds(ctx, { type: "SERVER_HIGH_CPU", payload: { value: 99 }, created_at: "" });
    assert.deepEqual(ids, [1000 + ADMIN]);
  });

  it("live output targets the owner's chat and never the last active user", () => {
    const { ctx, db, mk } = setup();
    const a = mk(USER_A);
    assert.deepEqual(liveOutputTarget(ctx, a.id), { userId: USER_A, chatId: 1000 + USER_A });
    db.upsertUserChat(USER_B, 5555);
    assert.deepEqual(liveOutputTarget(ctx, a.id), { userId: USER_A, chatId: 1000 + USER_A });
  });

  it("owner without a recorded chat → nowhere to send (no fallback to strangers)", () => {
    const { ctx, db } = setup();
    const s = db.createSession({ name: "x", project_id: null, agent_type: "shell", cwd: "/tmp", owner_telegram_user_id: 999 });
    assert.equal(liveOutputTarget(ctx, s.id), null);
  });

  it("legacy config (no admin_users): allowed users' chats all count as admin", () => {
    const config = makeConfig({ allowed_users: [USER_A] }); // no admin_users → legacy
    const db = new DB(tempDbFile());
    db.upsertUserChat(USER_A, 4242);
    const ctx = { db, config };
    const ids = notificationChatIds(ctx, { type: "SERVER_HIGH_CPU", created_at: "" });
    assert.deepEqual(ids, [4242]);
  });
});

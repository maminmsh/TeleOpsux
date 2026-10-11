import { DB } from "../db/database";
import { EventBus } from "../core/event-bus";
import { LogHub } from "../logger/logger";
import { Approval, ApprovalStatus } from "../shared/types";

export type ApprovalHandler = (approval: Approval) => void | Promise<void>;

/**
 * Approval Manager (docs §10/§37). Records approval requests, forwards the
 * decision back to the origin via registered handlers, and enforces a timeout
 * so a forgotten approval expires instead of blocking forever.
 */
export class ApprovalManager {
  private handlers = new Map<string, ApprovalHandler>();
  private expiry = new Map<number, NodeJS.Timeout>();

  constructor(
    private db: DB,
    private bus: EventBus,
    private logs: LogHub,
    private ttlMinutes = 30,
  ) {}

  registerHandler(actionType: string, handler: ApprovalHandler): void {
    this.handlers.set(actionType, handler);
  }

  request(params: {
    session_id: number | null;
    action_type: string;
    payload: Record<string, unknown>;
    telegram_message_id?: number;
    actor: string;
  }): Approval {
    const approval = this.db.createApproval(params);
    this.db.addMessage({
      session_id: params.session_id ?? 0,
      direction: "SYSTEM",
      content: `Approval requested: ${params.action_type} ${JSON.stringify(
        params.payload,
      )}`,
      source: "approval",
    });
    this.logs.audit.audit(params.actor, "APPROVAL_REQUESTED", {
      approval_id: approval.id,
      action: params.action_type,
      ...params.payload,
    });
    this.bus.emit({
      type: "APPROVAL_REQUIRED",
      session_id: params.session_id ?? undefined,
      payload: { approval_id: approval.id, action: params.action_type },
    });

    const timer = setTimeout(() => {
      const a = this.db.getApproval(approval.id);
      if (a?.status === "PENDING") this.resolve(approval.id, "EXPIRED", "system");
    }, this.ttlMinutes * 60_000);
    timer.unref?.();
    this.expiry.set(approval.id, timer);
    return approval;
  }

  resolve(id: number, status: ApprovalStatus, actor: string): void {
    const approval = this.db.getApproval(id);
    if (!approval || approval.status !== "PENDING") return;

    this.db.resolveApproval(id, status);
    const t = this.expiry.get(id);
    if (t) {
      clearTimeout(t);
      this.expiry.delete(id);
    }
    this.logs.audit.audit(actor, `APPROVAL_${status}`, {
      approval_id: id,
      action: approval.action_type,
    });

    if (status === "APPROVED") {
      const handler = this.handlers.get(approval.action_type);
      if (handler) {
        void Promise.resolve(handler(approval)).catch((err) =>
          this.logs.system.error("approval handler failed", {
            approval_id: id,
            error: String(err),
          }),
        );
      }
    }
  }

  pending(): Approval[] {
    return this.db.listPendingApprovals();
  }
}

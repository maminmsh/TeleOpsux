import crypto from "node:crypto";
import type { DB } from "../db/database";
import type { CredentialStatus } from "../shared/types";
import type { SecretBox } from "../shared/secret-box";

/**
 * Exact reply required when a Qoder session would start without the owner's
 * own credential. The session must NOT be created or started in that case.
 */
export const CREDENTIAL_REQUIRED_MESSAGE =
  "⛔ Qoder credential is not configured for your account.";

export class CredentialRequiredError extends Error {
  constructor() {
    super(CREDENTIAL_REQUIRED_MESSAGE);
    this.name = "CredentialRequiredError";
  }
}

/**
 * Refused input: Telegram messages persist, can be forwarded and cannot be
 * reliably deleted, so a credential is never accepted through chat.
 */
export const CREDENTIAL_IN_CHAT_MESSAGE =
  "⛔ API keys are never accepted in chat, task text or session input. " +
  "Run /qoderkey to store the credential on a single-use secure link.";

/**
 * Per-user Qoder credentials, keyed by TELEGRAM USER ID (never session id):
 * every session of a user runs with that user's own key, and one user's key is
 * never reachable from another user's session, logs, history, notifications or
 * any DB/API surface owned by them.
 *
 * Guarantees implemented here:
 *  - encrypted at rest (AES-256-GCM SecretBox, same key file as SSH passwords);
 *  - plaintext only ever handed to the launcher (writeCredentialFile) or used
 *    transiently for output redaction — never returned to UI layers;
 *  - no fallback to a server-wide API key or shared qoder login: if the user
 *    has no credential, status is "missing" and the caller must fail closed;
 *  - provisioning never happens in Telegram chat (single-use token links, see
 *    provision-server.ts); admins see statuses only.
 */
export class CredentialService {
  constructor(
    private db: DB,
    private box: SecretBox,
    private tokenTtlMinutes = 10,
  ) {}

  /** "missing" = no stored row. Never exposes any part of the value. */
  status(telegramUserId: number | null | undefined): CredentialStatus | "missing" {
    if (telegramUserId == null) return "missing";
    const row = this.db.getQoderCredential(telegramUserId);
    if (!row) return "missing";
    return row.status === "invalid" ? "invalid" : "configured";
  }

  hasCredential(telegramUserId: number | null | undefined): boolean {
    return this.status(telegramUserId) === "configured";
  }

  /** Basic shape check; rejects whitespace/control chars that would break shell env. */
  save(telegramUserId: number, plainKey: string): void {
    const key = plainKey.trim();
    if (key.length < 8 || key.length > 512)
      throw new Error("credential must be 8–512 characters");
    // control chars (incl. CR/LF) would break shell env injection
    if (/[\u0000-\u001f\u007f]/.test(key))
      throw new Error("credential contains control characters");
    this.db.purgeExpiredCredentialGrants();
    this.db.upsertQoderCredential(telegramUserId, this.box.encrypt(key));
  }

  remove(telegramUserId: number): void {
    this.db.deleteQoderCredential(telegramUserId);
    this.db.deleteCredentialGrantsForUser(telegramUserId);
  }

  /** Mark broken WITHOUT ever logging or echoing the value. */
  markInvalid(telegramUserId: number | null | undefined): void {
    if (telegramUserId == null) return;
    if (this.db.getQoderCredential(telegramUserId))
      this.db.setCredentialStatus(telegramUserId, "invalid");
  }

  /**
   * Internal launcher API: returns the decrypted key for the session OWNER so
   * it can be written to a 0600 file on the session host. Callers must never
   * log it, put it in argv, or return it to a UI surface.
   */
  revealForLaunch(telegramUserId: number): string | null {
    if (this.status(telegramUserId) !== "configured") return null;
    const row = this.db.getQoderCredential(telegramUserId);
    if (!row) return null;
    try {
      return this.box.decrypt(row.key_enc);
    } catch {
      // unreadable blob (key rotated?) — treat as invalid, fail closed
      this.db.setCredentialStatus(telegramUserId, "invalid");
      return null;
    }
  }

  /**
   * Defence in depth: if an agent ever prints an API key into pane output,
   * scrub EVERY stored credential before anything reaches Telegram, history or
   * logs. Not keyed on the viewer: a key belonging to user A must never be
   * readable by user B, even inside B's own session output.
   */
  redactAll(text: string): string {
    let out = text;
    for (const row of this.db.listCredentialKeyBlobs()) {
      try {
        const value = this.box.decrypt(row.key_enc);
        if (value && out.includes(value)) out = out.split(value).join("***REDACTED***");
      } catch {
        /* undecryptable row — nothing to scrub */
      }
    }
    return out;
  }

  /**
   * True when the text contains a stored credential of ANY user. Used to refuse
   * chat/task input: a key must never be typed into Telegram, because chat
   * messages persist, can be forwarded and cannot be reliably deleted.
   */
  containsStoredSecret(text: string): boolean {
    for (const row of this.db.listCredentialKeyBlobs()) {
      try {
        const value = this.box.decrypt(row.key_enc);
        if (value && text.includes(value)) return true;
      } catch {
        /* undecryptable row — nothing to compare */
      }
    }
    return false;
  }

  /** Single-use provisioning token; raw value goes ONLY into the link. */
  createProvisionToken(telegramUserId: number): string {
    this.db.purgeExpiredCredentialGrants();
    const token = crypto.randomBytes(24).toString("hex");
    const hash = this.hashToken(token);
    const expiresAt = new Date(Date.now() + this.tokenTtlMinutes * 60_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    this.db.createCredentialGrant(hash, telegramUserId, expiresAt);
    return token;
  }

  /** Returns the owning user id on success; null on invalid/expired/used. */
  consumeProvisionToken(token: string): number | null {
    const hash = this.hashToken(token);
    const grant = this.db.getCredentialGrant(hash);
    if (!grant || grant.used_at) return null;
    // compare via the hash lookup itself (random 48-hex ids are not enumerable)
    const expiresMs = Date.parse(grant.expires_at.replace(" ", "T") + "Z");
    if (!Number.isFinite(expiresMs) || Date.now() > expiresMs) return null;
    this.db.markCredentialGrantUsed(hash);
    return grant.telegram_user_id;
  }

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  /** Admin-visible listing — statuses only, never key material. */
  allStatuses(): Array<{ telegram_user_id: number; status: CredentialStatus; updated_at: string }> {
    return this.db.listCredentialStatuses();
  }
}

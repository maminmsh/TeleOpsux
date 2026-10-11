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
 * Refused input: outside the dedicated /qoderkey entry flow a token must never
 * appear in chat history, task text or session input (messages persist and can
 * be forwarded).
 */
export const CREDENTIAL_IN_CHAT_MESSAGE =
  "⛔ API keys are never accepted in chat, task text or session input. " +
  "Run /qoderkey and use \u201cSet token\u201d to store your credential.";

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
 *  - the token enters through the /qoderkey chat flow only (the bot deletes
 *    the messages right after saving); admins see statuses only.
 */
export class CredentialService {
  constructor(
    private db: DB,
    private box: SecretBox,
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

  /**
   * Shape checks for every entry point. Returns the trimmed credential or
   * null when it is unusable — never throws, never echoes the value.
   */
  normalizeKey(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const key = raw.trim();
    if (key.length < 8 || key.length > 512) return null;
    // control chars (incl. CR/LF) would break shell env injection
    if (/[\u0000-\u001f\u007f]/.test(key)) return null;
    return key;
  }

  /** Basic shape check; rejects whitespace/control chars that would break shell env. */
  save(telegramUserId: number, plainKey: string): void {
    const key = this.normalizeKey(plainKey);
    if (key === null) throw new Error("credential must be 8–512 characters without control characters");
    this.db.upsertQoderCredential(telegramUserId, this.box.encrypt(key));
  }

  remove(telegramUserId: number): void {
    this.db.deleteQoderCredential(telegramUserId);
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
   * chat/task/session input outside the /qoderkey entry flow, so a key never
   * lands in history, task text or an agent pane.
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

  /** Admin-visible listing — statuses only, never key material. */
  allStatuses(): Array<{ telegram_user_id: number; status: CredentialStatus; updated_at: string }> {
    return this.db.listCredentialStatuses();
  }
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * AES-256-GCM at-rest encryption with a 0600 32-byte hex key file, shared by
 * SSH host passwords and per-user Qoder credentials. Honest caveat (same as
 * HostService): this protects against DB dumps/backups, NOT against someone
 * with shell access to the TeleOps box.
 */
export class SecretBox {
  private key: Buffer | null = null;

  constructor(private keyFile: string) {}

  encrypt(plain: string): string {
    const key = this.loadKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      enc.toString("base64"),
    ].join(":");
  }

  decrypt(blob: string): string {
    const key = this.loadKey();
    const [ivB64, tagB64, dataB64] = blob.split(":");
    if (!ivB64 || !tagB64 || !dataB64) throw new Error("corrupted encrypted field");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  private loadKey(): Buffer {
    if (this.key) return this.key;
    if (fs.existsSync(this.keyFile)) {
      this.key = Buffer.from(fs.readFileSync(this.keyFile, "utf8").trim(), "hex");
      if (this.key.length !== 32)
        throw new Error(`${this.keyFile} is not a 32-byte hex key`);
    } else {
      this.key = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(path.resolve(this.keyFile)), { recursive: true });
      fs.writeFileSync(this.keyFile, this.key.toString("hex"), { mode: 0o600 });
    }
    return this.key;
  }
}

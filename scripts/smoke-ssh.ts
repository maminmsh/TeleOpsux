import { shq } from "../src/exec/exec-runner";
import { SshConnection } from "../src/ssh/ssh-connection";
import { SshRunner } from "../src/ssh/ssh-runner";
import { HostService } from "../src/ssh/host-service";
import { DB } from "../src/db/database";
import fs from "node:fs";

async function main() {
  console.log("shq:", shq("a'b c"));
  const dbFile = "/tmp/ssh-test.db";
  fs.rmSync(dbFile, { force: true });
  fs.rmSync("/tmp/ssh-test.key", { force: true });
  const db = new DB(dbFile);
  const hs = new HostService(db, "/tmp/ssh-test.key");
  const pw = `p@ss'"w0rd`;
  hs.addHost({ host: "example.com", port: 22, username: "u", password: pw, name: "t", activate: true });
  const creds = hs.getCredentials(hs.getActiveHost()!);
  console.log("crypto roundtrip:", creds.password === pw);

  const conn = new SshConnection(
    { host: "127.0.0.1", port: 22, username: "x", password: "x" },
    { readyTimeoutMs: 3000 },
  );
  const runner = new SshRunner(conn);
  const r1 = await runner.exec("echo", ["hi"]);
  console.log("down->code:", r1.code, "err:", r1.stderr.slice(0, 60));
  console.log("state:", conn.state);
  const r2 = await runner.exec("echo", ["hi"]);
  console.log("backoff msg:", r2.stderr.slice(0, 40));
  process.exit(0);
}
main();

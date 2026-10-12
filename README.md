# TeleOps — AI Command Center for Telegram

A server-side **control plane** for managing multiple persistent AI coding agents
(Qoder CLI, Codex CLI, shell, and future agents), Git workflows, server
monitoring, approvals, logs and alerts — all driven from Telegram.

Telegram is only the **view layer**. The core is UI-agnostic and communicates
over an internal event bus, so a Web dashboard / API can be added later without
touching the core.

> Manage multiple persistent AI coding sessions, Git workflows, server
> resources, approvals, logs, and automation directly from Telegram.

---

## Architecture (3 planes)

```
Interface        Telegram Bot  (src/telegram)  ── thin view layer only
   │
Control Plane ─── SessionManager · EventBus · Policy · Approval · Notification
   │              GitManager · ServerMonitor · Projects · Auth/Allowlist
   │                     (src/session, src/core, src/policy, src/approval,
   │                      src/notify, src/git, src/monitor, src/db)
   │
Execution Plane ── tmux PTY sessions ── Qoder / Codex / Shell adapters
                      (src/session/tmux.ts, src/adapters/*)
```

Key design decisions (see `TeleOps.md` for the full spec):

- **Persistent sessions** — every agent runs in its own `tmux` session, so
  closing Telegram, dropping the connection, or restarting the bot never kills
  the work. On restart, live panes are auto-reconnected (`SessionManager.recover`).
- **Agent-agnostic** — the core treats every agent as a terminal. Agent-specific
  launch commands and output interpretation live in `AgentAdapter` implementations.
- **Event-driven** — every significant change emits a `DomainEvent` on the bus,
  is persisted (timeline/audit), and the Notification Engine decides what to surface.
- **Security first** — allowlisted Telegram users only; secrets in env; all process
  calls use `execFile` with argument arrays (no shell interpolation); destructive
  Git/system commands are routed through the Policy + Approval layers.
- **Per-user ownership** — sessions, projects and SSH hosts belong to the Telegram
  user who created them (`owner_telegram_user_id`). Authorization is enforced in a
  central service layer (`src/auth/access.ts`), not hidden in the UI: every command
  argument, callback payload and stored pointer is re-authorized on each use.
  Admins see everything; normal users never learn whether someone else's resource
  exists (a single generic `⛔ You do not have access to this resource.`).

---

## Repository layout

```
src/
  config/         configuration loader (YAML + env)
  logger/         3-level logger: system / session / audit
  db/             SQLite (better-sqlite3) + schema + repositories + migrations
  auth/           central authorization layer (roles, ownership, resolvers)
  shared/         domain types & enums
  core/           event bus + app container
  session/        state machine, tmux wrapper, Session Manager
  adapters/       AgentAdapter interface, base + Qoder/Codex/Shell adapters
  git/            Git Manager (status/diff/log/branch/commit/push)
  monitor/        Server Monitor (CPU/RAM/Disk/Load/Processes/services/alerts)
  policy/         Policy Engine (allow / approval / deny)
  approval/       Approval Manager (requests, handlers, expiry)
  notify/         Notification Engine (rules -> sink) + per-owner routing
  credentials/    per-user API keys: encrypted store + optional PAT probe;
                  the token is entered as a chat reply and deleted after saving
  web/            Live Session Terminal Mini App: initData auth, output hub,
                  interactive tmux terminals, API server + embedded page
  telegram/       Telegram view layer (commands, menus, chat, live output)
  main.ts         composition root
test/             node:test suites (access, migration, routing, bot authz,
                  credentials, mini-app)
scripts/          smoke/e2e helpers + teleops.service
config/config.example.yaml
.env.example
```

---

## Requirements

- Node.js >= 20
- **tmux** (for persistent sessions) — `sudo apt install tmux` or `brew install tmux`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your numeric Telegram user id (get it from [@userinfobot](https://t.me/userinfobot))

---

## Setup

```bash
# 1. install dependencies
npm install

# 2. configure secrets
cp .env.example .env
#   -> set TELEGRAM_BOT_TOKEN
#   -> TELEOPS_SECRET_KEY_FILE is the AES key for stored credentials (keep it
#      outside the repo and back it up separately)

# 3. configure the control plane
mkdir -p config
cp config/config.example.yaml config/config.yaml
#   -> set security.allowed_users to your Telegram id(s)
#   -> set security.admin_users for real multi-user isolation
#      (omitting it treats every allowed user as an admin — legacy mode)
#   -> optionally set security.project_roots to the repos you manage
#   -> enable/disable agents under `agents:`

# 4. build
npm run build

# 5. run (production)
npm start

#   or during development (auto-reload):
npm run dev
```

If `TELEGRAM_BOT_TOKEN` is empty the bot starts in **core-only** mode (no
Telegram) — useful for wiring up config and testing the API/event layers.

---

## Usage from Telegram

```
/start            main menu
/sessions         list YOUR sessions (admins see all, with owner labels)
/new              create a session                  /session <id>  chat with one
/send <id> <msg>  send to your session without chat mode
/history <id> [limit]  input/output + event history of your session
/summary <id>     rule-based summary
/stop <id>        /resume <id>             /kill <id>
/git <id>         status/diff/log/commit/push (commit & push require approval)
/logs [id] [limit]  task logs of your sessions      /alerts  pending approvals + errors
/projects         projects you can access           /addproject  register one (private to you)
/removeproject <id>  delete a project you own
/hosts            YOUR servers, pick your active    /addserver   connect SSH server
/addserver        connect a remote server (becomes YOUR private host)
/server           CPU/RAM/Disk/load        /processes    top processes   (admin)
/health /settings                           global health & config summary (admin)
/claim <session|project|host> <id> [uid]    reassign ownership (admin only)
/qoderkey         status of YOUR Qoder token + set/replace/delete it (in chat)
/credentials      every user's credential STATUS (admin only — values are never shown)
/cancel           abort the current wizard
```

The **New Session** flow is a guided wizard: pick project → pick agent → type the
task. The session starts in `tmux`, output is aggregated into a single live
message (debounced), and you get a notification when the agent needs approval or
input — reply right from Telegram and the agent continues.

---

## Multi-user access, roles & ownership

Identity is always `ctx.from.id` (numeric Telegram user id) — never a username,
and callback data is never trusted; it is re-resolved through the authorization
layer on every click.

**Roles** (`config.yaml → security`):

| Role | Config | Rights |
|---|---|---|
| stranger | not in `allowed_users` | rejected silently |
| user | in `allowed_users` | only own (or `shared`) sessions/projects/hosts |
| admin | also in `admin_users` | everything, incl. legacy unowned data, global health/server/alerts, `/claim` |

Backward compatibility: if `admin_users` is **omitted**, every allowed user is an
admin (legacy single-owner mode). Set it explicitly — even to `[]` — for real
isolation.

**Ownership model:**

- `sessions.owner_telegram_user_id`, `projects.owner_telegram_user_id`,
  `ssh_hosts.owner_telegram_user_id` — set automatically at creation.
- `visibility = private | shared` on projects/hosts. `shared` resources are
  visible to every allowed user but only the owner or an admin may manage or
  delete them; only admins can flip visibility.
- **Legacy rows keep `owner = NULL` and become admin-only** — they are never
  exposed to other users and never deleted. An admin can hand one over with
  `/claim session <id> <uid>`.
- Notifications and live session output route to the **owner's** chat (recorded
  on /start or any authorized interaction). Non-session events (server alerts,
  approvals without a session) go to admins only. `admin_receive_all_notifications: true`
  additionally copies session events to admins. An owner who has never
  interacted simply receives nothing — routing never falls back to "last active user".
- Active SSH host is **per-user** (`user_active_hosts` table): picking your
  server doesn't move other users' commands. The global transport is only
  adopted for admins or when no host is active yet — see Limitations.

**Migration (schema v5, `src/db/migrations.ts`):** idempotent `ALTER TABLE ADD
COLUMN` + `CREATE TABLE IF NOT EXISTS` + indexes (`idx_sessions_owner` etc.) via
`PRAGMA user_version`. Upgrading an existing DB keeps every row; nothing is
reset or deleted. Run `npm run db:migrate` (or just start — migrations run at boot).

## Per-user Qoder credentials

Every Qoder session runs with **the owning user's own API key** — keys are never
shared between users and never shared with the server. An agent declares
`credentialEnvVar` on its adapter (`src/adapters/qoder-adapter.ts`), and that
declaration is what makes the whole feature fail-closed: any session of that
agent needs the owner's credential, otherwise

```
⛔ Qoder credential is not configured for your account.
```

is replied and the session is **not created and not started** (checked in the
Telegram layer *and* independently in `SessionManager.create/start`, so no other
entry point can bypass it). There is no fallback to a server-wide `QODER_PERSONAL_ACCESS_TOKEN`
or a shared `qoder` login: the launch command explicitly `unset`s an inherited
variable before exporting the owner's.

**Storage** (schema v6, cleaned in v7): `qoder_credentials` is keyed by
`telegram_user_id` (never session id) and holds `key_enc` — AES-256-GCM via
`SecretBox` (`src/shared/secret-box.ts`, the same 0600 key file as SSH
passwords). Statuses are `configured` / `invalid`; *missing* means no row.
The old `credential_grants` table (single-use provisioning links) is dropped
by migration v7.

**Token entry — in the chat, then wiped from it.** `/qoderkey` shows the status
and a link to <https://qoder.com/account/integrations> where the user creates a
PAT. Tapping **Set/Replace token** makes the bot wait for one plain reply: the
token is shape-checked, probed against Qoder, encrypted, saved — and then the
bot **deletes both the user's message and the prompt** and confirms with the
status only. If deletion fails (e.g. the bot lacks delete rights) the user is
told to remove the message manually. Outside that explicit flow `sendInput` and
task text are still refused whenever they contain any stored key. One token per
account: a new reply replaces the stored one.

**Launch injection** (`SessionManager.start`): the key is written through the
runner's *stdin* into `$HOME/.teleops-credentials/teleops-session-<id>.key`
(`umask 077`, `chmod 600`) on the session host, and the pane command only ever
shows the path — `sh -c 'unset QODER_PERSONAL_ACCESS_TOKEN QODER_API_KEY; QODER_PERSONAL_ACCESS_TOKEN="$(cat …)"; rm -f …;
export QODER_PERSONAL_ACCESS_TOKEN; exec qoder'`. The file deletes itself as the agent starts,
and `stop()` (or a failed launch) removes any leftover. The plaintext is thus
absent from argv, the tmux pane, `capture-pane`, task logs, session history,
notifications and TeleOps' own process environment. As defence in depth every
outbound string is scrubbed (`redactAll`) and an auth failure detected in the
pane flips the status to `invalid` (never logging the value) and notifies the
owner to run `/qoderkey` again.

**The token is verified before it is stored** (`src/credentials/pat-validator.ts`):
the supported, non-destructive CLI check — `qoder --list-models` — authenticates
and exits without starting a session or spending completion tokens. The PAT is
passed to that child **through its environment only** (never argv), with
`HOME`/`--config-dir` pointed at a private 0700 scratch directory that is deleted
afterwards, so no other login can mask or be replaced by it. `QODER_API_KEY` is
explicitly unset for the probe. A rejected token is reported and not persisted; if
the probe cannot run (CLI missing, timeout, network) the credential is still
stored but the answer says *"could not verify"* rather than pretending success.
Turn it off with `credentials.validate_pat: false`.

**Restarting:** `sudo systemctl restart teleops` (unit in
`scripts/teleops.service`), or `npm run dev` / `npm start` if you run it by hand;
`node dist/main.js` needs `npm run build` first. Startup and runtime log lines
never contain a credential. The pending "waiting for your token reply" state is
in-memory only — after a restart the user just taps Set token again.

**Key rotation** (`data/teleops.key`, 0600, outside git). Rotate the
`TELEOPS_SECRET_KEY_FILE` by re-encrypting in one controlled pass, because
existing rows would otherwise decrypt as garbage and be flipped to `invalid`:

```bash
cp data/teleops.key data/teleops.key.bak.$(date +%F)   # rollback = restore this
# 1) decrypt everything with the OLD key, 2) write the new 32-byte hex key,
# 3) re-encrypt qoder_credentials.key_enc and ssh_hosts.password_enc with it.
shred -u data/teleops.key.bak.<date>                   # after a verified restart
```
Users must run `/qoderkey` again only if a row cannot be re-encrypted; the status
(`invalid`) tells them and the admin so.

**Revocation:** the user taps "Delete my credential" in `/qoderkey` (two taps), or
an operator deletes the row (`DELETE FROM qoder_credentials WHERE telegram_user_id=…`).
Running sessions keep the key they were launched with; the next launch is blocked
until a new credential is provided. Revoke the token itself at
<https://qoder.com/account/integrations> — TeleOps cannot revoke it server-side.

**Deletion:** `/qoderkey` → "Delete my credential" requires a second
confirmation tap (the confirmation must exist in server-side state, so replayed
callback data alone cannot delete anything). Deleting one user's key never
touches another user's sessions. Admins see statuses only (`/credentials`).

## Live Session Terminal Mini App (webapp)

A Telegram Mini App (WebApp) for watching and steering sessions with a real
live terminal, alongside — not replacing — the chat commands.

**What it does**
- Every session created by the wizard gets a prominent **🖥 Open Session
  Terminal** button (also on `/sessions` → session chat entry). Telegram's Bot
  API never lets a bot *force-open* a Mini App — the user taps the button;
  that is the compliant maximum.
- Opening without a session (no `?session=` / start param) shows the sessions
  list: live statuses (the real state-machine values), agent, project, last
  activity, active-first ordering — scoped by the same ownership rules as the
  bot. Creating a session inside the Mini App goes through the real
  `SessionManager.create/start` gates and then jumps directly to its page.
- The session page streams live output chunk-by-chunk over **SSE** (the page
  consumes it with fetch-streaming so the auth header can ride along), with
  `AGENT` / `SHELL` / `SYSTEM` sources, timestamps, a fixed-height scrollable
  pane, auto-scroll pinned to the bottom (releases when you scroll up), copy,
  stop/resume and the real status badge. Initial view = last 50 lines in
  chronological order; after a TeleOps restart the stored pane tail seeds the
  buffer. Reconnects resume at the last seen `seq` — no duplicates, no gaps
  (within the 500-line ring retention).
- Every selected session offers the same three actions: **🖥 Live** (streaming
  terminal), **📜 Last 50 lines** (stored output read from the persisted
  event log, read-only — shell-pane lines are live-only and were never
  stored) and **🗑 Delete** (confirm first; stops the agent, kills both
  panes, then removes the session row and all its stored history). In the
  Telegram bot the same trio sits on each session page: the 🖥 Open Session
  Terminal button (live Mini App), a new 📜 Last 50 lines button and a new
  🗑 Delete session button (owner/admin only, irreversible).
- Two strictly separated input modes:
  - **💬 Agent Chat** → `SessionManager.sendInput` → the agent pane
    (`teleops-<id>`), the same path as the bot chat.
  - **🖥 Linux Terminal** → a dedicated persistent tmux shell
    (`teleops-term-<id>`) opened on the *session's current transport* (the
    active SSH host when the project is remote — commands never leak onto
    the TeleOps control box by accident) at the project cwd. Real interactive
    state: `cd` persists, `npm test` keeps running, Ctrl+C is delivered as an
    actual tmux key (fixed allowlist), long jobs survive page disconnects
    (reap after 30 min idle). It never touches the agent pane, and shell
    input never merges into agent stdin.
- The shell runs as the service account TeleOps itself connects with. No
  sudo, no root escalation is ever added.

**Security model**
- Every `/api/*` call carries Telegram `initData` in the
  `X-Telegram-Init-Data` header, HMAC-verified against the bot token
  (`src/web/telegram-init-data`). The raw auth data is never in URLs, logs or
  error messages; the page's own `user.id` is ignored as identity proof.
- Session ids from the client are untrusted selectors: every operation
  re-resolves them through the central auth layer (`src/auth/access`) —
  including on every live-stream push. Foreign and unknown ids return the
  same generic refusal.
- All output is scrubbed (`redactSecrets` + stored-key redaction) before it
  leaves the server; confidential tokens are never displayed.
- SSE listeners/timers are torn down on client disconnect and server
  shutdown; per-user fixed-window rate limits apply.

**Enabling it**
1. `TELEOPS_WEBAPP_URL=https://<public-host>/teleops/` (or `webapp.url` in
   config). Register the same domain/app with @BotFather.
2. Run a TLS reverse proxy for the loopback API port (8718) that passes the
   `X-Telegram-Init-Data` header and does NOT buffer SSE
   (`proxy_buffering off;` + `proxy_read_timeout` ≥ 60s in nginx). A
   non-loopback bind without an https:// URL is refused at startup.
3. Restart TeleOps. Without a URL the feature is fully inert (no server,
   no button).

*Honesty notes:* live delivery follows the existing capture-diff pipeline
(`sessions.heartbeat_interval_seconds` for the agent pane, ~700 ms polling for
shell panes) — chunk-by-chunk push, but that is the architecture's native
cadence, not per-byte PTY streaming. Browser rendering and the real
Telegram client tap-through are not covered by automated tests; the suite
drives the actual HTTP API with correctly signed initData and a tmux-fake
transport.

## Tests

```bash
npm test          # node:test + tsx — access, migration, routing, bot authz, credentials, mini-app
npm run typecheck
npm run build
```

`test/credentials.test.ts` proves the isolation contract: A's session gets
exactly A's key (and B's appears nowhere in it), B cannot create or start a
Qoder session while unprovisioned even though A is, a server-wide
`QODER_PERSONAL_ACCESS_TOKEN` (or the legacy `QODER_API_KEY`) is never inherited, the plaintext never appears in a command
line / pane / capture / history / DB file, output is scrubbed, the /qoderkey
reply flow saves the token, deletes both messages and never echoes the value,
and deletion is confirmed and per-user.

---

## Deployment

### systemd (recommended for MVP)

See `scripts/teleops.service`. Adjust `User`, `WorkingDirectory`, and put the bot
token in an `EnvironmentFile` (not in the unit).

```bash
sudo cp scripts/teleops.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now teleops
```

### Notes on Docker

Dockerization must account for tmux, PTY, Git, and host project access; agents
need real access to the projects. Native server deployment (systemd) is simplest
for the MVP.

---

## Known limitations

- **One global SSH transport.** TeleOps keeps a single active SSH connection at
  any moment; per-user host selection scopes lists, queries and UI, but when a
  normal user's host is *not* the global transport, their commands queue on the
  current one only if it belongs to them — otherwise the bot tells them their
  host was not adopted. Full per-user connection multiplexing is future work.
- Ad-hoc sessions without a project (running in the TeleOps box cwd) are
  admin-only.
- Legacy `NULL`-owner resources stay admin-only until reassigned with `/claim`.
  A legacy Qoder session is therefore **blocked** (fail-closed) until an admin
  claims it for a user who has a credential.
- **Credential staging needs a writable `$HOME` on the session host**, and while
  the 0600 file exists (a few milliseconds before the agent starts) anyone who
  can already read that user's files — i.e. `root` on a shared box — could read
  it. TeleOps never puts the key in argv, logs or the pane, but OS-level
  isolation between users on the same host is still the operator's job.
- The token is typed into a chat message during the /qoderkey flow. TeleOps
  deletes both messages right after saving, but Telegram offers no absolute
  guarantee: if deletion fails the user is warned to remove the message
  manually. Never leave the bot without delete permission in chats where it is
  used for credentials.
- Credential provisioning is currently Qoder-only by design: the gate is driven
  by `credentialEnvVar` on the adapter, so another agent gets the same behaviour
  by declaring it — its own key form/field would still need UI work.

---

## Roadmap (matches spec phases)

Done for MVP: Foundation · Session Manager · Qoder/Shell/Codex adapters ·
Telegram Chat UI · Git Manager · Monitoring · Approval & Policy ·
multi-user permissions & per-user session/project/host ownership.

Next: Web dashboard, per-user SSH connection multiplexing, session tags/search,
Git worktree isolation for parallel sessions, resource-aware scheduler,
auto-recovery policies, and the AI Orchestrator.

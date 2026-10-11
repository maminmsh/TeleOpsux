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
  credentials/    per-user API keys: encrypted store + one-time provisioning form
  telegram/       Telegram view layer (commands, menus, chat, live output)
  main.ts         composition root
test/             node:test suites (access, migration, routing, bot authz, credentials)
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
/qoderkey         status of YOUR agent credential + a one-time secure link
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

**Storage** (schema v6): `qoder_credentials` is keyed by
`telegram_user_id` (never session id) and holds `key_enc` — AES-256-GCM via
`SecretBox` (`src/shared/secret-box.ts`, the same 0600 key file as SSH
passwords). Statuses are `configured` / `invalid`; *missing* means no row.
`credential_grants` holds only **sha256 hashes** of single-use provisioning
tokens with an expiry.

**Provisioning — a key is never accepted in chat.** Telegram messages persist,
can be forwarded and cannot be reliably deleted, so `/qoderkey` hands out a
one-time link (`credentials.provision`) to a minimal form page; the value is
POSTed there, encrypted, and only the success/failure status returns to the
chat. Links expire after `token_ttl_minutes` (default 10) and are marked used on
first submit. `sendInput`/task text are additionally refused if they contain any
stored key.

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

**Transport decision:** the form binds to `127.0.0.1` by default — localhost is a
browser secure context and the key never crosses the network; remote users
tunnel to it (`ssh -L 8717:127.0.0.1:8717 …`). Behind a TLS-terminating reverse
proxy, set `credentials.provision.base_url` to the `https://` origin. The server
**refuses** to bind a non-loopback address while links would be plain HTTP.
Set `enabled: false` for strict fail-closed deployments (no self-service path at
all — Qoder stays blocked until a credential is provisioned out of band).

**Deletion:** `/qoderkey` → "Delete my credential" requires a second
confirmation tap (the confirmation must exist in server-side state, so replayed
callback data alone cannot delete anything). Deleting one user's key never
touches another user's sessions. Admins see statuses only (`/credentials`).

## Tests

```bash
npm test          # node:test + tsx — access, migration, routing, bot authz, credentials
npm run typecheck
```

`test/credentials.test.ts` proves the isolation contract: A's session gets
exactly A's key (and B's appears nowhere in it), B cannot create or start a
Qoder session while unprovisioned even though A is, a server-wide
`QODER_PERSONAL_ACCESS_TOKEN` (or the legacy `QODER_API_KEY`) is never inherited, the plaintext never appears in a command
line / pane / capture / history / DB file, output is scrubbed, provisioning
links are single-use, and deletion is confirmed and per-user.

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
- The provisioning form is a plain HTTP server on `127.0.0.1`; there is no
  built-in TLS. Use an SSH tunnel or your own reverse proxy (see above).
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

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

---

## Repository layout

```
src/
  config/         configuration loader (YAML + env)
  logger/         3-level logger: system / session / audit
  db/             SQLite (better-sqlite3) + schema + repositories
  shared/         domain types & enums
  core/           event bus + app container
  session/        state machine, tmux wrapper, Session Manager
  adapters/       AgentAdapter interface, base + Qoder/Codex/Shell adapters
  git/            Git Manager (status/diff/log/branch/commit/push)
  monitor/        Server Monitor (CPU/RAM/Disk/Load/Processes/services/alerts)
  policy/         Policy Engine (allow / approval / deny)
  approval/       Approval Manager (requests, handlers, expiry)
  notify/         Notification Engine (rules -> sink)
  telegram/       Telegram view layer (commands, menus, chat, live output)
  main.ts         composition root
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
/sessions         list sessions            /new          create a session
/session <id>     chat with a session      /summary <id> rule-based summary
/stop <id>        /resume <id>             /kill <id>
/server           CPU/RAM/Disk/load        /processes    top processes
/git <id>         status/diff/log/commit/push (commit & push require approval)
/logs <id>        last lines of a session  /alerts  pending approvals + errors
/projects         configured projects      /settings     current config summary
```

The **New Session** flow is a guided wizard: pick project → pick agent → type the
task. The session starts in `tmux`, output is aggregated into a single live
message (debounced), and you get a notification when the agent needs approval or
input — reply right from Telegram and the agent continues.

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

## Roadmap (matches spec phases)

Done for MVP: Foundation · Session Manager · Qoder/Shell/Codex adapters ·
Telegram Chat UI · Git Manager · Monitoring · Approval & Policy.

Next: multi-user permissions, per-user session ownership, Web dashboard,
session tags/search, Git worktree isolation for parallel sessions, resource-aware
scheduler, auto-recovery policies, and the AI Orchestrator.

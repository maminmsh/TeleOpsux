# AI Command Center for Telegram

## Telegram-based AI Development & Server Control Center

> A server-side control plane for managing multiple AI coding agents, persistent terminal sessions, Git workflows, server monitoring, approvals, logs, alerts, and future AI orchestration through Telegram.

---

## 1. خلاصه پروژه

این پروژه یک **مرکز کنترل چند Agent هوش مصنوعی و سرور از داخل تلگرام** است.

ایده اصلی این نیست که صرفاً یک Terminal را داخل Telegram نمایش دهیم. هدف این است که روی سرور یک **Control Plane / Session Manager** داشته باشیم که بتواند چند Session واقعی از ابزارهای CLI مبتنی بر AI مانند:

- Qoder CLI
- Codex CLI
- Claude Code یا Agentهای مشابه در آینده
- Shell / Bash

را مدیریت کند و Telegram فقط رابط کاربری، کنترل و Notification این سیستم باشد.

کاربر باید بتواند از گوشی یا دسکتاپ داخل Telegram:

- Session جدید بسازد.
- Sessionهای فعال را ببیند.
- با هر Agent مثل یک چت واقعی گفتگو کند.
- کار Agent را متوقف، ادامه یا لغو کند.
- آخرین وضعیت و خروجی Session را ببیند.
- خطاها را دریافت کند.
- زمانی که Agent منتظر تأیید یا پاسخ کاربر است، Notification دریافت کند.
- وضعیت CPU، RAM، Disk، Process و Serviceهای سرور را ببیند.
- Git را مدیریت کند.
- Diff، Status، Log، Branch، Commit، Pull و Push را کنترل کند.
- چند پروژه و چند Session را همزمان مدیریت کند.
- بعداً چند نوع Agent را از طریق Adapterهای مستقل به یک سیستم واحد متصل کند.
- در مرحله‌های بعد، یک Orchestrator هوش مصنوعی داشته باشد که خودش Session مناسب را انتخاب و کارها را بین Agentها تقسیم کند.

---

# 2. Vision

## چشم‌انداز نهایی

هدف نهایی ساخت یک **AI Operations & Development Control Center** است که بتواند توسعه نرم‌افزار و مدیریت سرور را از یک رابط یکپارچه انجام دهد.

تصویر نهایی:

```text
                         ┌──────────────────┐
                         │     Telegram     │
                         │  Mobile / Desktop│
                         └─────────┬────────┘
                                   │
                                   ▼
                    ┌──────────────────────────┐
                    │   Telegram Control UI    │
                    └────────────┬─────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │    AI Command Center     │
                    │          Core            │
                    └────────────┬─────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
          ▼                      ▼                      ▼
   Session Manager         Git Manager            Server Monitor
          │                      │                      │
          │                      │                      │
    ┌─────┼──────┐               │             ┌────────┼────────┐
    ▼     ▼      ▼               ▼             ▼        ▼        ▼
  Qoder Codex  Other            Git          CPU      RAM      Disk
   #1    #2    Agent             │             │        │        │
                                 ▼             └────────┼────────┘
                              GitHub                     │
                                                         ▼
                                                   Alerts / Events
```

---

# 3. Problem Statement

ابزارهایی مثل Qoder CLI یا Codex CLI برای کار روی پروژه عالی هستند، اما زمانی که Agent روی سرور اجرا می‌شود مشکلات عملی زیر به وجود می‌آید:

1. کاربر همیشه به Terminal دسترسی ندارد.
2. Session ممکن است طولانی باشد.
3. لازم است از گوشی پروژه را کنترل کرد.
4. خروجی Terminal ممکن است بسیار طولانی باشد.
5. Agent ممکن است برای تأیید متوقف شود.
6. Agent ممکن است Error دهد و منتظر کاربر بماند.
7. چند Session همزمان مدیریت کردن سخت است.
8. وضعیت سرور از وضعیت Agent جدا است.
9. Git معمولاً باید جداگانه مدیریت شود.
10. بعد از قطع اتصال، کاربر باید بتواند به همان Session قبلی برگردد.
11. هر Agent CLI رابط و رفتار مخصوص خودش را دارد.

این پروژه این مشکلات را با یک لایه مدیریت مرکزی حل می‌کند.

---

# 4. اصول طراحی

## 4.1 Persistent Sessions

هر AI Session باید مستقل از Telegram باشد.

بسته‌شدن Telegram، قطع اینترنت یا Restart شدن Bot نباید باعث از بین رفتن Session شود.

نمونه:

```text
Telegram
   ↓
Session Manager
   ↓
tmux / PTY
   ↓
Qoder CLI
```

در صورت Restart شدن Bot:

```text
Telegram
   ↓
Session Manager
   ↓
Reconnect
   ↓
Existing Session
   ↓
Qoder
```

---

## 4.2 Agent Agnostic

Core پروژه نباید فقط برای Qoder نوشته شود.

Qoder اولین Adapter است، نه هسته سیستم.

ساختار مفهومی:

```text
AgentAdapter
    ├── QoderAdapter
    ├── CodexAdapter
    ├── ClaudeAdapter
    ├── ShellAdapter
    └── FutureAdapter...
```

---

## 4.3 Event Driven

تمام تغییرات مهم باید Event تولید کنند.

مثال:

```text
SESSION_CREATED
SESSION_STARTED
SESSION_RECONNECTED
SESSION_OUTPUT
AGENT_WORKING
AGENT_WAITING
APPROVAL_REQUIRED
USER_INPUT_REQUIRED
COMMAND_STARTED
COMMAND_FAILED
COMMAND_FINISHED
TEST_FAILED
BUILD_FAILED
GIT_CHANGED
COMMIT_CREATED
PROCESS_CRASHED
SESSION_STOPPED
SESSION_FINISHED
SERVER_LOW_MEMORY
SERVER_HIGH_DISK_USAGE
```

Event Engine تصمیم می‌گیرد چه عملی انجام شود.

---

# 5. Scope نسخه اصلی

## 5.1 مدیریت AI Session

هر Session باید حداقل این اطلاعات را داشته باشد:

```yaml
id: 12
name: VTL Backend
agent: qoder
project: visual-trader-lab
cwd: /home/app/project/project with AI/visual-trader-lab
branch: feature/order-router
status: working
pid: 12345
terminal: ai-session-12
created_at: ...
last_activity: ...
last_output: ...
waiting_reason: null
```

### وضعیت‌های Session

```text
CREATED
STARTING
WORKING
WAITING_INPUT
WAITING_APPROVAL
ERROR
STOPPING
STOPPED
FINISHED
CRASHED
```

---

# 6. Telegram User Experience

## 6.1 منوی اصلی

```text
🤖 AI COMMAND CENTER

[ 🧠 Sessions ]
[ 📁 Projects ]
[ 🖥 Server ]
[ 🌿 Git ]
[ 📜 Logs ]
[ ⚠️ Alerts ]
[ ⚙️ Settings ]
```

---

## 6.2 Sessions

فرمان:

```text
/sessions
```

نمونه خروجی:

```text
🤖 AI SESSIONS

1. VTL Backend
   Agent: Qoder
   Status: 🟢 Working
   Project: visual-trader-lab
   Branch: feature/order-router
   Last activity: 12 sec ago

2. Telegram Bot
   Agent: Qoder
   Status: 🟡 Waiting Approval
   Project: telegram-manager
   Branch: main

3. Browser Engine
   Agent: Codex
   Status: 🔴 Error
   Project: browser-platform
   Branch: rust-core
```

---

# 7. Chat With an Agent

کاربر نباید مجبور باشد با دستورات Terminal کار کند.

مثلاً:

```text
/session 12
```

سپس:

```text
👤 User:
Order router را بررسی کن و مشکل تست‌ها را پیدا کن.

🤖 Qoder:
I found 3 failing tests...

[working...]

🤖 Qoder:
I modified:

src/router/orderRouter.ts
src/router/validation.ts

Tests:
✅ 18 passed
❌ 2 failed

Would you like me to continue?
```

کاربر می‌تواند مستقیماً پاسخ دهد:

```text
ادامه بده
```

و سیستم باید این متن را به **همان Session زنده** ارسال کند.

---

# 8. ارسال خروجی CLI به Telegram

نباید هر خط خروجی CLI به یک پیام جدا تبدیل شود.

راهکار پیشنهادی:

### Live Message Aggregation

یک پیام Telegram مرتب Update شود.

نمونه:

```text
🤖 Qoder #12
━━━━━━━━━━━━━━━━

Working...

> Reading src/router/order.ts
> Inspecting tests
> Running pnpm test

Tests:
████████░░ 78%

18 passed
2 failed
```

بعد از اتمام:

```text
✅ Task completed

Files changed: 6
Tests: 23 passed
Commit: a81d2f1
```

---

# 9. Session Summary

کاربر نباید مجبور باشد چند هزار خط خروجی را بخواند.

فرمان:

```text
/session 12/summary
```

نمونه:

```text
🧠 SESSION SUMMARY

Agent: Qoder
Project: VTL
Duration: 4h 12m

Completed:
✅ Refactored order router
✅ Added validation
✅ Added 17 tests

Failed:
❌ 2 integration tests

Current:
🟡 Waiting for user

Last question:
Should I modify the PostgreSQL migration?

Changed:
6 files

Last commit:
a81d2f1
```

در آینده می‌توان این Summary را با یک مدل AI تولید کرد، اما نسخه اول می‌تواند Rule-based باشد.

---

# 10. Approval System

این بخش یکی از قابلیت‌های کلیدی پروژه است.

Agent ممکن است برای ادامه کار به اجازه کاربر نیاز داشته باشد.

مثال:

```text
⚠️ QODER #12

Agent is waiting for approval.

Action:
Delete 14 files

Reason:
Refactoring obsolete modules.

[ ✅ Approve ]
[ ❌ Reject ]
[ 💬 Reply ]
```

یا:

```text
⚠️ Agent needs input

Which database migration should be used?

1. PostgreSQL 17
2. PostgreSQL 16
3. Keep existing

[1] [2] [3]
```

و یا:

```text
⚠️ CONFIRMATION REQUIRED

Command:

sudo systemctl restart postgresql

[ Approve ] [ Reject ]
```

---

# 11. تشخیص وضعیت Waiting

System باید بتواند تا حد ممکن تشخیص دهد که Agent در چه وضعیتی قرار گرفته است.

مثلاً:

```text
🟢 WORKING
🟡 WAITING_INPUT
🟡 WAITING_APPROVAL
🔴 ERROR
⚫ STOPPED
```

منبع تشخیص می‌تواند ترکیبی باشد از:

- خروجی stdout/stderr
- PTY state
- process state
- exit codes
- الگوهای متنی
- Adapter اختصاصی Agent
- heartbeat
- timeout

بهتر است این سیستم **Rule-based + Adapter-aware** طراحی شود، نه صرفاً بر اساس کلمات کلیدی.

---

# 12. Error Handling

مثال:

```text
❌ ERROR

Project: VTL
Session: #12

Type:
Test Failure

Command:
pnpm test

Result:
2 failed

Agent:
Qoder

Waiting for:
User instruction
```

کاربر می‌تواند پاسخ دهد:

```text
خودت علتش رو پیدا کن و اصلاح کن
```

و Session ادامه می‌یابد.

---

# 13. Notification Engine

تمام Eventها نباید به یک شکل Notify شوند.

نمونه Rule:

```yaml
APPROVAL_REQUIRED:
  action: telegram_notify

USER_INPUT_REQUIRED:
  action: telegram_notify

COMMAND_FAILED:
  action: telegram_notify

PROCESS_CRASHED:
  action: restart_and_notify

SERVER_LOW_MEMORY:
  action: telegram_notify

DISK_OVER_90_PERCENT:
  action: telegram_notify
```

---

# 14. Auto Recovery

در مراحل بعد امکان Recovery خودکار وجود دارد.

مثلاً:

```text
Qoder process crashed
       ↓
Session Manager detects crash
       ↓
Try reconnect
       ↓
If reconnect fails
       ↓
Restart Agent
       ↓
Notify Telegram
```

اما عملیات خطرناک باید Policy داشته باشند و خودکار اجرا نشوند مگر اینکه کاربر صراحتاً مجاز کرده باشد.

---

# 15. Git Management

Git باید یکی از اجزای اصلی Control Center باشد.

## اطلاعات Git

```text
Branch:
feature/order-router

Modified:
M src/router/orderRouter.ts
M src/router/validation.ts
?? tests/router.test.ts

Recent commits:
a81d2f1 Fix order validation
91bc1de Add router tests
```

---

## عملیات Git

```text
[ Diff ]
[ Status ]
[ Log ]
[ Branches ]
[ Checkout ]
[ Commit ]
[ Pull ]
[ Push ]
[ Stash ]
```

نمونه:

```text
/git status 12
/git diff 12
/git log 12
/git commit 12 "Fix order router validation"
```

برای Git Push بهتر است Approval فعال باشد.

---

# 16. Git Safety

قبل از Commit یا Push باید امکان مشاهده Diff وجود داشته باشد.

مثلاً:

```text
⚠️ COMMIT REQUEST

Branch:
feature/order-router

Files:
6 changed

Insertions: +241
Deletions: -78

[ View Diff ]
[ Commit ]
[ Cancel ]
```

برای Push:

```text
⚠️ PUSH REQUEST

Repository:
visual-trader-lab

Branch:
feature/order-router

Remote:
origin

[ ✅ Push ]
[ ❌ Cancel ]
```

---

# 17. Server Monitoring

فرمان:

```text
/server
```

نمونه:

```text
🖥 SERVER STATUS

CPU       18%
RAM       61%
Disk      64%
Load      0.21

Docker    8 containers
Services  14 running

AI Sessions
🟢 3 Working
🟡 1 Waiting
🔴 1 Error
```

---

## 17.1 CPU / RAM / Disk

حداقل Metrics:

```text
CPU usage
Load average
RAM used/free/available
Swap
Disk usage
Disk IO
Network RX/TX
Uptime
```

---

## 17.2 Processes

```text
/processes
```

نمونه:

```text
TOP PROCESSES

qoder       42% CPU
node        11%
postgres     7%
python       4%
```

---

## 17.3 Logs

```text
/logs
```

یا:

```text
/logs qoder 12
```

خروجی باید آخرین N خط را نمایش دهد و امکان Pagination داشته باشد.

---

# 18. Service Monitoring

قابلیت‌های آینده:

```text
/systemd
/docker
/containers
/services
```

مثلاً:

```text
SERVICES

🟢 postgres
🟢 redis
🟢 code-server
🟢 vtl-api
🔴 trading-worker
```

و:

```text
/service trading-worker
```

اطلاعات:

```text
Status: failed
Restarts: 4
Last error: ...
```

---

# 19. Server Alerts

نمونه Thresholdها:

```yaml
cpu:
  warning: 80
  critical: 95

ram:
  warning: 80
  critical: 90

disk:
  warning: 80
  critical: 90

load:
  enabled: true
```

Notification:

```text
🚨 SERVER ALERT

Disk usage reached 91%

Server: production-01

Used: 34.5 GB
Free: 3.4 GB
```

---

# 20. Projects

سیستم باید بتواند چند Project را مدیریت کند.

نمونه:

```text
📁 PROJECTS

1. Visual Trader Lab
2. Telegram Manager
3. Browser Engine
4. AI Video Tools
```

هر Project می‌تواند چند Session داشته باشد.

```text
Visual Trader Lab
├── Qoder #12 Backend
├── Qoder #13 Frontend
└── Qoder #14 AI Worker
```

---

# 21. چند Session همزمان

سیستم باید بتواند همزمان چند Session را اجرا کند.

مثلاً:

```text
Qoder #12 → VTL Backend
Qoder #13 → VTL Frontend
Qoder #14 → Telegram Bot
Codex #21 → Browser Engine
```

هر Session باید Context مستقل داشته باشد:

```text
project
cwd
agent
pid
terminal
branch
status
messages
events
```

---

# 22. معماری پیشنهادی

```text
                         Telegram Bot
                              │
                              ▼
                   ┌──────────────────────┐
                   │ Telegram UI / Router │
                   └──────────┬───────────┘
                              │
                              ▼
                   ┌──────────────────────┐
                   │      Core API        │
                   └──────────┬───────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
 Session Manager        Git Manager          Server Monitor
         │                    │                    │
         ▼                    ▼                    ▼
 Agent Adapters            Git CLI          OS / Docker / systemd
         │
  ┌──────┼────────┐
  ▼      ▼        ▼
Qoder   Codex   Other
  │       │        │
  └───────┼────────┘
          ▼
      PTY / tmux
          │
          ▼
     Running Process
```

---

# 23. Core Components

## 23.1 Telegram Gateway

وظایف:

- دریافت Message
- مدیریت Command
- مدیریت Inline Keyboard
- مدیریت Callback Query
- نمایش Session
- ارسال Notification
- دریافت Approval
- Pagination

---

## 23.2 Session Manager

مهم‌ترین جزء سیستم.

وظایف:

- Create Session
- Start Session
- Stop Session
- Resume Session
- Reconnect
- Send Input
- Capture Output
- Detect Status
- Track PID
- Track Working Directory
- Track Agent
- Track project
- Track branch

---

# 24. PTY / tmux

معماری پیشنهادی نسخه اول:

```text
Session Manager
       │
       ▼
     tmux
       │
       ▼
 Qoder / Codex
```

مزیت‌ها:

- Persistent terminal
- مستقل از اتصال Telegram
- مناسب برای SSH/Server
- امکان attach/re-attach
- تحمل قطع اتصال
- مدیریت چند Session

PTY layer وظیفه انتقال ورودی/خروجی را دارد و tmux می‌تواند lifecycle ترمینال را پایدار نگه دارد.

---

# 25. Agent Adapter Interface

طرح مفهومی:

```ts
interface AgentAdapter {
  id: string;
  name: string;

  createSession(options: CreateSessionOptions): Promise<AgentSession>;
  start(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  sendInput(sessionId: string, input: string): Promise<void>;
  getStatus(sessionId: string): Promise<AgentStatus>;
  getOutput(sessionId: string, options?: OutputOptions): Promise<string>;
  detectWaiting(output: string): WaitingState | null;
  summarize(sessionId: string): Promise<SessionSummary>;
}
```

Qoder و Codex هرکدام Implementation مستقل خود را دارند.

---

# 26. Session Data Model

نمونه:

```sql
CREATE TABLE sessions (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    project_id UUID NOT NULL,
    agent_type TEXT NOT NULL,
    cwd TEXT NOT NULL,
    terminal_id TEXT,
    pid INTEGER,
    status TEXT NOT NULL,
    branch TEXT,
    waiting_reason TEXT,
    last_output TEXT,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);
```

---

# 27. Event Model

نمونه:

```sql
CREATE TABLE session_events (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL,
    type TEXT NOT NULL,
    payload JSONB,
    created_at TIMESTAMP NOT NULL
);
```

مثال:

```json
{
  "type": "APPROVAL_REQUIRED",
  "session_id": "...",
  "payload": {
    "command": "sudo systemctl restart postgresql",
    "reason": "Database service restart requested"
  }
}
```

---

# 28. Message Model

برای اینکه Telegram دقیقاً به یک Session متصل باشد:

```sql
CREATE TABLE session_messages (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL,
    direction TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT,
    created_at TIMESTAMP NOT NULL
);
```

`direction`:

```text
USER_TO_AGENT
AGENT_TO_USER
SYSTEM
```

---

# 29. Approval Model

```sql
CREATE TABLE approvals (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL,
    action_type TEXT NOT NULL,
    payload JSONB,
    status TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL,
    resolved_at TIMESTAMP
);
```

Status:

```text
PENDING
APPROVED
REJECTED
EXPIRED
```

---

# 30. Policy Engine

Core باید یک لایه Policy داشته باشد تا Agent نتواند بدون کنترل هر دستور سیستمی را اجرا کند.

مثال:

```yaml
allowed:
  - git status
  - git diff
  - git log
  - npm test
  - pnpm test
  - npm run build

approval_required:
  - git push
  - docker compose down
  - systemctl restart
  - rm
  - sudo
```

سطوح دسترسی پیشنهادی:

```text
LEVEL 0
Read Only

LEVEL 1
Project Commands

LEVEL 2
Git Operations

LEVEL 3
System Commands

LEVEL 4
Privileged / Destructive Operations
```

---

# 31. امنیت

چون این سیستم به Terminal و پروژه‌ها دسترسی دارد، امنیت جزو Core Feature است.

## الزامات اولیه

- فقط Userهای مجاز Telegram حق دسترسی داشته باشند.
- Telegram User ID در Allowlist نگهداری شود.
- Token در Environment Variable نگهداری شود.
- Secretها در Git Commit نشوند.
- دستورات حساس نیاز به Approval داشته باشند.
- Audit Log نگهداری شود.
- امکان خاموش‌کردن Remote Shell مستقل وجود داشته باشد.
- Sessionهای حساس امکان Read-only داشته باشند.
- Command Injection و Shell Injection کنترل شود.
- Path Traversal کنترل شود.
- Project Rootها محدود شوند.
- زمان Timeout برای Commandها وجود داشته باشد.

---

# 32. Audit Log

هر عملیات مهم باید ثبت شود:

```text
2026-10-08 14:10
User approved:
sudo systemctl restart postgresql

2026-10-08 14:11
Session #12 restarted

2026-10-08 14:12
Git push requested

2026-10-08 14:12
User rejected push
```

---

# 33. Command Routing

Telegram Commandهای پایه:

```text
/start
/help
/status
/sessions
/session <id>
/new
/stop <id>
/resume <id>
/kill <id>
/projects
/server
/processes
/logs
/git
/settings
/alerts
```

اما UX اصلی بهتر است Button + Chat باشد و Commandها برای کاربران حرفه‌ای باقی بمانند.

---

# 34. نمونه Flow کامل

## ساخت Session جدید

```text
/new
```

Bot:

```text
Select project:

[ VTL ]
[ Telegram Bot ]
[ Browser Engine ]
```

سپس:

```text
Select Agent:

[ Qoder ]
[ Codex ]
[ Shell ]
```

سپس:

```text
Enter task:
```

کاربر:

```text
Backend order router را بررسی کن و تست‌ها را اجرا کن.
```

سیستم:

```text
✅ Session #27 created

Agent: Qoder
Project: VTL
Status: 🟢 Starting
```

---

# 35. Flow اجرای Task

```text
User message
     ↓
Telegram Gateway
     ↓
Session Resolver
     ↓
Session Manager
     ↓
Agent Adapter
     ↓
PTY / tmux
     ↓
Qoder
     ↓
stdout/stderr
     ↓
Event Parser
     ↓
State Machine
     ↓
Telegram Update
```

---

# 36. Flow خطا

```text
Agent
  ↓
Command failed
  ↓
Parser detects failure
  ↓
Event: COMMAND_FAILED
  ↓
Notification Engine
  ↓
Telegram
```

کاربر:

```text
خودت حلش کن.
```

سپس:

```text
Telegram
  ↓
Existing Session
  ↓
Agent Adapter
  ↓
Same Agent Context
```

---

# 37. Flow Approval

```text
Agent requests sensitive action
          ↓
Policy Engine
          ↓
APPROVAL_REQUIRED
          ↓
Approval Manager
          ↓
Telegram notification
          ↓
User Approve / Reject
          ↓
Approval Manager
          ↓
Session Manager
          ↓
Agent continues / stops
```

---

# 38. وضعیت Session و Heartbeat

Session باید Heartbeat داشته باشد تا مشخص شود واقعاً زنده است.

نمونه:

```yaml
heartbeat_interval: 5s
timeout: 30s
```

اگر Heartbeat قطع شود:

```text
WORKING
   ↓
NO_HEARTBEAT
   ↓
VERIFY_PROCESS
   ↓
RECONNECTED / CRASHED
```

---

# 39. جلوگیری از پیام‌های بیش از حد Telegram

Agent ممکن است هزاران خط خروجی تولید کند.

بنابراین:

### Buffer

```text
CLI output
    ↓
Output Buffer
    ↓
Aggregator
    ↓
Telegram message update
```

قابلیت‌ها:

- Rate limiting
- Debounce
- Chunking
- Max message size handling
- Log compression
- Collapsible/summary output

---

# 40. Long Output

اگر خروجی از ظرفیت مناسب Telegram بزرگ‌تر شد:

```text
📜 Large output detected

[ Last 100 lines ]
[ Full log ]
[ Summary ]
```

نسخه اول می‌تواند Full Log را روی سرور نگه دارد و فقط بخش موردنیاز را در Telegram نشان دهد.

---

# 41. پروژه و Session Isolation

هر Session باید Context مشخص خود را داشته باشد.

مثال:

```yaml
project:
  id: vtl
  root: /home/app/project/project with AI/visual-trader-lab

session:
  id: 12
  cwd: /home/app/project/project with AI/visual-trader-lab
  branch: feature/order-router
  agent: qoder
```

Agent نباید به شکل پیش‌فرض خارج از Project Root عملیات انجام دهد، مگر اینکه Policy اجازه دهد.

---

# 42. State Machine پیشنهادی

```text
             ┌────────────┐
             │   CREATED  │
             └─────┬──────┘
                   ▼
             ┌────────────┐
             │  STARTING  │
             └─────┬──────┘
                   ▼
             ┌────────────┐
       ┌────▶│  WORKING   │◀─────┐
       │     └─────┬──────┘      │
       │           │             │
       │           ▼             │
       │   ┌────────────────┐    │
       │   │ WAITING_INPUT  │────┘
       │   └────────────────┘
       │
       │   ┌────────────────┐
       └───│WAITING_APPROVAL│────┐
           └───────┬────────┘    │
                   │             │
                   ▼             │
             ┌────────────┐      │
             │   ERROR    │──────┘
             └─────┬──────┘
                   ▼
             ┌────────────┐
             │  STOPPED   │
             └────────────┘
```

---

# 43. Recommended Technology Stack

## Core Server

یکی از انتخاب‌های مناسب برای MVP:

```text
Node.js / TypeScript
```

دلایل:

- مناسب Telegram Bot
- مناسب Process/PTY integration
- اکوسیستم خوب برای Backend
- توسعه سریع
- Type safety

---

## Telegram

گزینه‌های مناسب:

```text
grammY
Telegraf
```

برای پروژه TypeScript می‌توان از grammY یا Telegraf استفاده کرد.

---

## Terminal / PTY

```text
tmux
node-pty
```

معماری:

```text
node-pty
   ↕
tmux
   ↕
AI CLI
```

---

## Database

برای MVP کوچک:

```text
SQLite
```

برای نسخه بزرگ‌تر:

```text
PostgreSQL
```

---

## Cache / Eventing

در ابتدا می‌توان بدون Redis شروع کرد.

در مقیاس بالاتر:

```text
Redis
```

برای:

- event queue
- pub/sub
- live state
- locks
- transient data

---

# 44. پیشنهاد ساختار Repository

```text
ai-command-center/
│
├── apps/
│   ├── bot/
│   └── api/
│
├── packages/
│   ├── core/
│   ├── session-manager/
│   ├── agent-adapters/
│   │   ├── qoder/
│   │   ├── codex/
│   │   └── shell/
│   ├── git-manager/
│   ├── server-monitor/
│   ├── approval-manager/
│   ├── policy-engine/
│   ├── notification-engine/
│   └── shared/
│
├── data/
├── logs/
├── config/
├── scripts/
├── tests/
├── .env.example
├── docker-compose.yml
└── README.md
```

برای MVP حتی می‌توان Repository را ساده‌تر نگه داشت و بعداً Modularize کرد.

---

# 45. Configuration

نمونه:

```yaml
telegram:
  enabled: true

sessions:
  max_concurrent: 8
  heartbeat_interval: 5
  reconnect: true

security:
  allowed_users:
    - TELEGRAM_USER_ID

agents:
  qoder:
    enabled: true
    command: qoder

  codex:
    enabled: false
    command: codex

monitor:
  cpu_warning: 80
  cpu_critical: 95
  ram_warning: 80
  ram_critical: 90
  disk_warning: 80
  disk_critical: 90
```

---

# 46. Environment Variables

نمونه:

```env
TELEGRAM_BOT_TOKEN=
DATABASE_URL=
SESSION_ROOT=/var/lib/ai-command-center/sessions
LOG_ROOT=/var/log/ai-command-center
NODE_ENV=production
```

Secretها نباید داخل Repository قرار گیرند.

---

# 47. Docker

برای خود پروژه می‌توان Docker را اختیاری نگه داشت.

نکته مهم: Agentها ممکن است به دسترسی واقعی به Project و Host نیاز داشته باشند. بنابراین Dockerization باید با درنظرگرفتن PTY، tmux، Git، Docker Socket و Permissionها طراحی شود.

برای MVP Server-native deployment می‌تواند ساده‌تر باشد:

```text
systemd
   ↓
ai-command-center
```

---

# 48. systemd

نمونه Service:

```ini
[Unit]
Description=AI Command Center
After=network.target

[Service]
Type=simple
User=app
WorkingDirectory=/home/app/ai-command-center
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

---

# 49. Logging Architecture

سه سطح لاگ:

```text
SYSTEM LOG
SESSION LOG
AUDIT LOG
```

### System Log

خطاها و رخدادهای خود Control Center.

### Session Log

خروجی Agent و Session.

### Audit Log

اقدامات کاربر و عملیات حساس.

---

# 50. Web UI در آینده

Telegram باید Interface اصلی MVP باشد، اما Core نباید وابسته به Telegram باشد.

بعداً می‌توان اضافه کرد:

```text
Telegram
      │
      ├── Mobile UI
      │
      └── Web Dashboard
```

Web Dashboard می‌تواند:

- Terminal Viewer
- Session Tree
- Server Charts
- Git Diff Viewer
- Logs
- Agent Timeline
- Approval Queue

داشته باشد.

---

# 51. API Layer

حتی در صورتی که MVP Bot-centric باشد، بهتر است Core API داخلی داشته باشد.

نمونه Endpointها:

```http
GET    /sessions
POST   /sessions
GET    /sessions/:id
POST   /sessions/:id/input
POST   /sessions/:id/stop
POST   /sessions/:id/resume
GET    /sessions/:id/logs
GET    /sessions/:id/events

GET    /projects
GET    /projects/:id/git/status
GET    /projects/:id/git/diff
POST   /projects/:id/git/commit
POST   /projects/:id/git/push

GET    /server/status
GET    /server/processes
GET    /server/services
```

---

# 52. Event Bus

برای MVP می‌توان Event Bus ساده داخلی ساخت:

```text
EventEmitter
```

در نسخه بزرگ‌تر:

```text
Redis Pub/Sub
```

یا Message Queue.

هدف این است که Session Manager مستقیماً به Telegram وابسته نباشد.

---

# 53. Telegram به عنوان View Layer

یک اصل معماری مهم:

```text
Core ≠ Telegram
```

Telegram فقط یکی از Clientها است.

مثلاً:

```text
                  Core
                   │
        ┌──────────┼──────────┐
        ▼          ▼          ▼
     Telegram     API       Web UI
```

این تصمیم باعث می‌شود بعداً اضافه کردن Web Dashboard یا Mobile App آسان‌تر شود.

---

# 54. Orchestrator AI در آینده

پس از پایدارشدن Core می‌توان یک Orchestrator ساخت.

```text
                   User
                    │
                    ▼
             Orchestrator AI
                    │
       ┌────────────┼─────────────┐
       ▼            ▼             ▼
     Qoder         Codex        Shell
```

Orchestrator می‌تواند:

1. پروژه را انتخاب کند.
2. Agent مناسب را انتخاب کند.
3. Task را به Session بفرستد.
4. وضعیت را پایش کند.
5. خطا را تحلیل کند.
6. تست را اجرا کند.
7. Git Diff را بررسی کند.
8. در نقاط حساس Approval بگیرد.
9. در پایان Summary تولید کند.

---

# 55. Multi-Agent Workflow

مثلاً:

```text
User:
نسخه جدید Order Router را آماده کن.
```

Orchestrator:

```text
Qoder
↓
Implement code

Codex
↓
Review code

Shell/Test Agent
↓
Run tests

Git Manager
↓
Prepare diff

Telegram
↓
Ask approval
```

بعد:

```text
Approve
↓
Commit
↓
Push
```

---

# 56. AI Session Scheduler

در آینده سیستم می‌تواند Sessionها را از نظر منابع مدیریت کند.

مثلاً:

```text
Server RAM: 4 GB

Qoder #1  → 1.2 GB
Qoder #2  → 0.9 GB
Codex #3  → 1.0 GB

Available memory too low
```

در نتیجه:

```text
New Session
   ↓
Resource Check
   ↓
Queue / Start
```

این قابلیت برای VPSهای کوچک بسیار مفید است.

---

# 57. Resource-aware Session Manager

هر Session در آینده می‌تواند Resource Estimate داشته باشد:

```yaml
cpu_limit: 2
memory_limit_mb: 1024
priority: normal
```

Priority:

```text
LOW
NORMAL
HIGH
CRITICAL
```

---

# 58. Session Tags

برای مدیریت بهتر:

```text
#backend
#frontend
#urgent
#research
#production
#testing
```

مثلاً:

```text
/sessions #backend
```

---

# 59. Search

در آینده:

```text
/search order router
```

جستجو در:

- Session messages
- Events
- Logs
- Projects
- Git commits

---

# 60. Timeline

برای هر Session یک Timeline می‌تواند وجود داشته باشد:

```text
14:02 Session started
14:03 Agent started
14:10 Files changed
14:18 Tests started
14:22 Tests failed
14:25 Agent waiting
14:26 User replied
14:31 Tests passed
14:35 Commit prepared
14:36 Approval requested
```

این Timeline در Debug کردن سیستم بسیار ارزشمند است.

---

# 61. Session Resume After Server Restart

در صورتی که Agent بتواند با Session پایدار دوباره متصل شود، Manager باید بعد از Restart سرور وضعیت قبلی را بازیابی کند.

هدف:

```text
Server reboot
     ↓
Control Center starts
     ↓
Load persisted sessions
     ↓
Detect running terminals
     ↓
Reconnect
     ↓
Notify Telegram
```

اگر یک Session دیگر وجود نداشته باشد:

```text
⚠️ Session #12 was not recovered
Reason: process not found
```

---

# 62. Idempotency

Operationهایی که ممکن است دوبار اجرا شوند باید کنترل شوند.

مثلاً:

```text
User taps Push twice
```

سیستم نباید Push را دوبار به شکل ناخواسته اجرا کند.

برای عملیات مهم باید:

- Request ID
- Lock
- Status
- Idempotency key

درنظر گرفته شود.

---

# 63. Concurrency

ممکن است چند Session همزمان روی یک Project کار کنند.

این موضوع باید از ابتدا مدیریت شود.

حالات خطرناک:

```text
Qoder #1 → modifies backend
Qoder #2 → modifies same backend
```

راهکارهای پیشنهادی:

- هشدار Conflict
- Workspace جدا
- Git worktree
- Branch جدا برای هر Session
- Project Lock

برای نسخه حرفه‌ای، استفاده از **Git Worktree برای Sessionهای موازی** بسیار مناسب است.

---

# 64. Git Worktree Strategy

مثلاً:

```text
project/

.worktrees/
├── session-12/
├── session-13/
└── session-14/
```

هر Agent روی workspace خودش کار می‌کند.

این کار احتمال خراب‌شدن همزمان پروژه را کم می‌کند.

---

# 65. Session Naming

نام خودکار:

```text
Qoder #12 - VTL Backend
```

یا نام دستی:

```text
/payment-refactor
```

---

# 66. Quick Actions

برای هر Session دکمه‌های اصلی:

```text
[ 💬 Chat ]
[ 📜 Logs ]
[ 📊 Status ]
[ 🌿 Git ]
[ ⏸ Pause ]
[ ▶ Resume ]
[ 🛑 Stop ]
[ 🧠 Summary ]
```

---

# 67. Error Escalation

سطوح خطا:

```text
INFO
WARNING
ERROR
CRITICAL
```

مثلاً:

```text
INFO:
Agent started

WARNING:
High CPU usage

ERROR:
Tests failed

CRITICAL:
Disk full
```

---

# 68. Notification Rules قابل تنظیم

کاربر بتواند داخل Settings تعیین کند:

```text
Notify me when:

☑ Session finished
☑ Session failed
☑ Agent waiting
☑ Approval required
☑ Git changed
☑ Server RAM > 85%
☑ Disk > 90%
☐ Every normal output
```

این امکان جلوی Flood شدن Telegram را می‌گیرد.

---

# 69. Quiet / Smart Notification Mode

در آینده:

```text
Normal output
→ no notification

Task completed
→ notification

Question
→ notification

Error
→ notification

Critical server alert
→ notification
```

---

# 70. Security Boundary پیشنهادی

پیشنهاد معماری:

```text
Telegram
   ↓
Authentication
   ↓
Authorization
   ↓
Policy Engine
   ↓
Session Manager
   ↓
Agent / Shell
```

هیچ درخواست Telegram نباید مستقیماً به Shell برسد.

---

# 71. Threat Model اولیه

مواردی که باید از ابتدا در نظر گرفته شوند:

### Telegram Account Compromise

اگر حساب Telegram لو رفت، Bot نباید دسترسی نامحدود داشته باشد.

### Bot Token Leak

Token باید فقط در Environment/Secret Manager باشد.

### Command Injection

Input کاربر نباید بدون کنترل وارد shell شود.

### Path Traversal

مسیر فایل‌ها باید محدود شود.

### Privilege Escalation

sudo و دستورات حساس نیاز به کنترل داشته باشند.

### Session Hijacking

هر Session باید مالک/کاربر مجاز خود را داشته باشد.

---

# 72. MVP دقیق

## Phase 0: Foundation

هدف: ساخت Core پایه

قابلیت‌ها:

- TypeScript project
- Configuration
- Logging
- Database
- Telegram authentication
- User allowlist

---

## Phase 1: Session Manager

قابلیت‌ها:

- Create Session
- Start Session
- Stop Session
- Resume Session
- tmux integration
- PTY integration
- Session state
- Output capture

---

## Phase 2: Qoder Adapter

```text
Qoder CLI
   ↓
QoderAdapter
   ↓
Session Manager
```

قابلیت‌ها:

- Launch
- Input
- Output
- Status
- Waiting detection
- Error detection
- Reconnect

---

## Phase 3: Telegram Chat UI

قابلیت‌ها:

- Session list
- Open session
- Send message
- Live output
- Summary
- Stop / Resume
- Notifications

---

## Phase 4: Git Manager

قابلیت‌ها:

- Status
- Diff
- Log
- Branches
- Checkout
- Commit
- Pull
- Push
- Approval

---

## Phase 5: Monitoring

قابلیت‌ها:

- CPU
- RAM
- Disk
- Load
- Processes
- Services
- Logs
- Alerts

---

## Phase 6: Approval & Policy

قابلیت‌ها:

- Rule Engine
- Approval Queue
- Sensitive commands
- Audit Logs
- User permissions

---

## Phase 7: Multi-Agent

اضافه کردن:

```text
CodexAdapter
ClaudeAdapter
Other CLI adapters
```

---

## Phase 8: Automation

قابلیت‌ها:

- Auto retry
- Auto reconnect
- Crash recovery
- Scheduled tasks
- Event-based actions

---

## Phase 9: Orchestrator AI

قابلیت‌ها:

- Task decomposition
- Agent selection
- Multi-agent workflow
- Automatic verification
- Smart summaries
- Self-recovery with policy controls

---

# 73. MVP Success Criteria

MVP زمانی موفق است که این سناریو بدون SSH و بدون Terminal مستقیم قابل انجام باشد:

```text
1. User opens Telegram.
2. User creates Qoder Session.
3. Selects project.
4. Sends task.
5. Qoder works on server.
6. User closes Telegram.
7. Session keeps running.
8. Agent reaches approval/question.
9. User receives Telegram notification.
10. User answers from Telegram.
11. Agent continues.
12. User views Git Diff.
13. User approves Commit/Push.
14. User sees final summary.
```

اگر این Flow پایدار باشد، هسته محصول ساخته شده است.

---

# 74. Out of Scope برای MVP

برای جلوگیری از بزرگ‌شدن بی‌دلیل پروژه، این موارد در MVP نباید اولویت باشند:

- Web dashboard کامل
- Mobile native app
- Multi-user SaaS
- Billing
- Public marketplace
- Distributed cluster
- Multi-server orchestration
- Full AI autonomous coding loop
- Complex Kubernetes integration

این‌ها باید بعد از اثبات Core اضافه شوند.

---

# 75. Multi-Server در آینده

پس از موفقیت نسخه Single Server می‌توان معماری را به چند Server گسترش داد.

```text
                    Telegram
                       │
                       ▼
                Central Controller
                 /      |       \
                /       |        \
               ▼        ▼         ▼
           Server A  Server B   Server C
             │          │          │
            Qoder      Codex      Shell
```

در این حالت هر Server یک Agent Node اجرا می‌کند.

---

# 76. Node Agent Architecture آینده

```text
Central Control Plane
          │
          ▼
     Node Protocol
          │
    ┌─────┼─────┐
    ▼     ▼     ▼
 Node A Node B Node C
```

Nodeها می‌توانند:

- Session ایجاد کنند.
- Process اجرا کنند.
- Metrics ارسال کنند.
- Logs ارسال کنند.
- Event بفرستند.
- Command دریافت کنند.

---

# 77. ایده محصول نهایی

محصول نهایی می‌تواند ترکیبی از این مفاهیم باشد:

```text
AI Coding Agent Manager
+
Terminal Session Manager
+
Git Control
+
Server Monitoring
+
Approval System
+
Notification Engine
+
Multi-Agent Orchestrator
```

مرکز فرمان همچنان Telegram است.

---

# 78. چرا Telegram مناسب است؟

Telegram در این معماری صرفاً یک Chat App نیست، بلکه می‌تواند رابط Command + Notification باشد.

مزایا:

- دسترسی از گوشی
- دسترسی از دسکتاپ
- Inline Buttons
- Callback Actions
- Notification فوری
- Chat history
- مناسب برای Commandهای کوتاه

اما Core نباید به Telegram وابسته شود.

---

# 79. اصل طلایی معماری

سه لایه باید از هم جدا باشند:

```text
1. Interface
   Telegram / Web

2. Control Plane
   Sessions / Events / Policies

3. Execution Plane
   tmux / PTY / Qoder / Codex / Shell
```

این تفکیک مهم‌ترین تصمیم معماری پروژه است.

---

# 80. Final Architecture

```text
┌───────────────────────────────────────────────────────────┐
│                       USER INTERFACE                      │
│                                                           │
│                    Telegram / Web UI                      │
└──────────────────────────────┬────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────┐
│                       CONTROL PLANE                       │
│                                                           │
│  Auth        Session Manager       Event Engine           │
│  Policy      Approval Manager      Notification Engine    │
│  Project     Git Manager           Server Monitor         │
└──────────────────────────────┬────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────┐
│                      EXECUTION PLANE                      │
│                                                           │
│        PTY / tmux / Processes / Filesystem / Git         │
│                                                           │
│   ┌──────────┐   ┌──────────┐   ┌────────────────────┐   │
│   │ Qoder    │   │ Codex    │   │ Other CLI Agents   │   │
│   └──────────┘   └──────────┘   └────────────────────┘   │
└───────────────────────────────────────────────────────────┘
```

---

# 81. مسیر توسعه پیشنهادی

ترتیب توسعه باید به این صورت باشد:

```text
Foundation
   ↓
Persistent Session
   ↓
Qoder Adapter
   ↓
Telegram Chat
   ↓
Git
   ↓
Monitoring
   ↓
Approval / Policy
   ↓
Multi-Agent
   ↓
Automation
   ↓
Orchestrator AI
```

هر مرحله باید مستقل قابل استفاده باشد.

---

# 82. نتیجه نهایی

این پروژه را نباید به عنوان:

> «یک Bot برای اجرای Qoder»

تعریف کرد.

تعریف دقیق‌تر:

> **A Telegram-first control plane for persistent AI development sessions, Git operations, server operations, monitoring, approvals, alerts, and future multi-agent orchestration.**

Qoder فقط اولین Agent است.

Codex، Claude و سایر Agentها بعداً از طریق Adapter اضافه می‌شوند.

Telegram رابط اصلی است، اما Core مستقل از Telegram باقی می‌ماند.

Sessionها روی سرور زنده می‌مانند و با tmux/PTY مدیریت می‌شوند.

Git، Server Monitoring، Logs، Approval و Notification به عنوان اجزای بومی سیستم طراحی می‌شوند.

در نهایت، این سیستم می‌تواند از یک «کنترلر Qoder از راه دور» به یک **AI Command Center کامل برای توسعه و مدیریت سرور** تبدیل شود.

---

# 83. نام موقت پروژه

نام‌های پیشنهادی:

- AI Command Center
- AgentOps
- AgentDock
- AI Session Control
- TermiAI
- DevOps AI Control
- Telegram AI Command Center

نام نهایی در مرحله Product Design انتخاب شود.

---

# 84. تعریف یک‌خطی پروژه

> **Manage multiple persistent AI coding sessions, Git workflows, server resources, approvals, logs, and automation directly from Telegram.**


/**
 * The Live Session Terminal Mini App page — a single self-contained file
 * (HTML+CSS+vanilla JS) embedded as a string, following this project's
 * precedent of shipping web UI from code (tsc does not copy static assets).
 *
 * Every API call carries the raw initData in a HEADER (never the URL);
 * identity and ownership are decided server-side by the MiniAppServer.
 * Data is rendered with textContent only — no HTML injection.
 */
export const MINI_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>TeleOps Session Terminal</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root, .theme-light {
  --bg:#f5f5f7; --panel:#ffffff; --ink:#1c1e21; --muted:#6b7280;
  --line:#e3e5e8; --accent:#2b7cff; --ok:#1a9e4b; --warn:#c77700; --err:#c0392b;
  --agent:#0b6b3a; --shell:#1f4ea1; --system:#7a5aa8; --input-bg:#ffffff;
}
.theme-dark {
  --bg:#0f1115; --panel:#171a20; --ink:#e7e9ea; --muted:#9aa1a9;
  --line:#262b33; --accent:#4f8dfd; --ok:#37b269; --warn:#e6a23c; --err:#e05c50;
  --agent:#5ec98f; --shell:#7fb0ff; --system:#b794e6; --input-bg:#10131a;
}
* { box-sizing:border-box; }
html,body { margin:0; height:100%; }
body { background:var(--bg); color:var(--ink); font:15px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif; display:flex; flex-direction:column; }
#topbar { display:flex; align-items:center; gap:8px; padding:8px 12px; background:var(--panel); border-bottom:1px solid var(--line); flex:0 0 auto; }
#back { border:0; background:none; color:var(--accent); font-size:15px; padding:6px; cursor:pointer; }
#title { font-weight:600; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#badge { font-size:12px; padding:3px 9px; border-radius:999px; background:var(--line); white-space:nowrap; }
main { flex:1; display:flex; flex-direction:column; min-height:0; }
.view { display:none; flex-direction:column; min-height:0; flex:1; }
.view.on { display:flex; }
#banner { display:none; padding:8px 12px; background:#8a1f1f; color:#fff; font-size:13px; }
#banner.on { display:block; }
/* list */
#list { overflow-y:auto; padding:10px; }
.row { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 12px; margin-bottom:8px; cursor:pointer; }
.row .l1 { display:flex; gap:8px; align-items:baseline; }
.row .nm { font-weight:600; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.row .idx { color:var(--muted); font-size:12px; }
.row .l2 { display:flex; gap:8px; align-items:baseline; margin-top:3px; color:var(--muted); font-size:12.5px; flex-wrap:wrap; }
.st-WORKING{color:var(--ok)} .st-STARTING,.st-STOPPING{color:var(--warn)}
.st-WAITING_INPUT,.st-WAITING_APPROVAL{color:var(--warn);font-weight:600}
.st-ERROR,.st-CRASHED{color:var(--err);font-weight:600}
.st-STOPPED{color:var(--muted)} .st-FINISHED{color:var(--ok);font-weight:600}
#newbtn { margin:6px 12px 12px; }
#create { display:none; margin:10px; padding:12px; background:var(--panel); border:1px solid var(--line); border-radius:10px; }
#create.on { display:block; }
select,textarea,input { font:inherit; background:var(--input-bg); color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:8px; width:100%; margin-bottom:8px; }
button { font:inherit; border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:8px; padding:7px 12px; cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button:disabled { opacity:.45; }
/* terminal */
#meta { padding:8px 12px; font-size:12.5px; color:var(--muted); background:var(--panel); border-bottom:1px solid var(--line); flex:0 0 auto; }
#meta b { color:var(--ink); }
#out { flex:1; overflow-y:auto; padding:10px 12px; margin:0; background:var(--bg);
  font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre-wrap; word-break:break-word; }
#out .ln { display:block; }
#out .t { color:var(--muted); margin-right:6px; }
#out .s-agent { color:var(--agent); font-weight:600; margin-right:6px; }
#out .s-shell { color:var(--shell); font-weight:600; margin-right:6px; }
#out .s-system { color:var(--system); font-weight:600; margin-right:6px; }
#controls { display:flex; gap:6px; padding:8px 12px 0; flex-wrap:wrap; flex:0 0 auto; }
#views { display:flex; gap:6px; padding:8px 12px 0; flex-wrap:wrap; flex:0 0 auto; }
#views button.on { background:var(--accent); border-color:var(--accent); color:#fff; }
#vdel { color:var(--err); }
#modes { display:flex; gap:6px; padding:8px 12px 0; flex:0 0 auto; }
#modes button.on { background:var(--accent); border-color:var(--accent); color:#fff; }
#sendrow { display:flex; gap:6px; padding:8px 12px calc(10px + env(safe-area-inset-bottom)); flex:0 0 auto; }
#sendrow textarea { flex:1; margin:0; resize:none; min-height:40px; max-height:120px; }
#send { align-self:stretch; }
#hint { padding:0 12px 8px; color:var(--muted); font-size:11.5px; flex:0 0 auto; }
</style>
</head>
<body>
<div id="topbar">
  <button id="back" title="Back to sessions">&#8592; Sessions</button>
  <div id="title">TeleOps Sessions</div>
  <div id="badge" class="st-STOPPED">offline</div>
</div>
<div id="banner"></div>
<main>
  <section id="listview" class="view on">
    <div id="list"></div>
    <div id="create">
      <select id="cproj"></select>
      <select id="cagent"></select>
      <textarea id="ctask" rows="3" placeholder="Task for the new session (optional)"></textarea>
      <div style="display:flex;gap:6px">
        <button id="cgo" class="primary">Create session</button>
        <button id="ccancel">Cancel</button>
      </div>
    </div>
    <button id="newbtn" class="primary">➕ New session</button>
  </section>
  <section id="detailview" class="view">
    <div id="meta"></div>
    <div id="views">
      <button id="vlive" class="on">🖥 Live</button>
      <button id="vhist">📜 Last 50 lines</button>
      <button id="vdel">🗑 Delete</button>
    </div>
    <pre id="out"></pre>
    <div id="modes">
      <button id="mchat" class="on">💬 Agent Chat</button>
      <button id="mterm">🖥 Linux Terminal</button>
    </div>
    <div id="controls">
      <button id="stop">⏹ Stop</button>
      <button id="resume">▶ Resume</button>
      <button id="cc">^C Interrupt</button>
      <button id="copy">⧉ Copy</button>
    </div>
    <div id="sendrow">
      <textarea id="input" rows="1" placeholder="Message to the agent…"></textarea>
      <button id="send" class="primary">Send</button>
    </div>
    <div id="hint">Enter sends · Shift+Enter newline</div>
  </section>
</main>
<script>
"use strict";
var tg = window.Telegram.WebApp;
if (tg) { try { tg.ready(); tg.expand(); } catch (e) {} }
if (tg && tg.colorScheme === "dark") document.body.classList.add("theme-dark");
else document.body.classList.add("theme-light");

var H = { "X-Telegram-Init-Data": (tg && tg.initData) || "", "Content-Type": "application/json" };
var $ = function (id) { return document.getElementById(id); };
var state = { id: null, view: "live", mode: "chat", agentAfter: 0, termAfter: 0,
  agentAbort: null, termAbort: null, termActive: false, pinned: true, backoff: 1000 };
var MAX_LINES = 800;

function banner(msg) {
  var b = $("banner");
  if (!msg) { b.classList.remove("on"); b.textContent = ""; return; }
  b.textContent = msg; b.classList.add("on");
}
function api(path, opts) {
  return fetch(path, Object.assign({ headers: H }, opts || {}))
    .then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          if (r.status === 401) throw new Error("Session expired — reopen the Mini App from Telegram.");
          throw new Error((j && j.error) || ("HTTP " + r.status));
        }
        return j;
      });
    });
}
function fmtTime(iso) {
  var d = new Date(iso && iso.indexOf("T") < 0 ? iso + "Z" : iso);
  if (isNaN(d)) return "--:--";
  var hh = ("0" + d.getHours()).slice(-2), mm = ("0" + d.getMinutes()).slice(-2);
  return hh + ":" + mm;
}
function ago(iso) {
  var d = new Date(iso && iso.indexOf("T") < 0 ? iso + "Z" : iso);
  if (isNaN(d)) return "";
  var s = (Date.now() - d.getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return Math.round(s / 60) + "m ago";
  if (s < 172800) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}
var STATUS = { CREATED:"⚪ created", STARTING:"🟡 starting", WORKING:"🟢 working",
  WAITING_INPUT:"🟠 waits for input", WAITING_APPROVAL:"🟠 needs approval",
  ERROR:"🔴 error", STOPPING:"🟡 stopping", STOPPED:"⚪ stopped",
  FINISHED:"✅ finished", CRASHED:"🔴 crashed" };
function setBadge(status) {
  var b = $("badge");
  b.textContent = STATUS[status] || status;
  b.className = "st-" + status;
}

// ---------- output rendering ----------
var out = $("out");
out.addEventListener("scroll", function () {
  state.pinned = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
});
function addLine(source, at, text) {
  var span = document.createElement("span");
  span.className = "ln";
  var t = document.createElement("span"); t.className = "t"; t.textContent = fmtTime(at);
  var s = document.createElement("span"); s.className = "s-" + source;
  s.textContent = source.toUpperCase();
  var x = document.createElement("span"); x.textContent = text;
  span.appendChild(t); span.appendChild(s); span.appendChild(x);
  out.appendChild(span);
  while (out.childNodes.length > MAX_LINES) out.removeChild(out.firstChild);
  if (state.pinned) out.scrollTop = out.scrollHeight;
}

// ---------- SSE over fetch (headers carry initData; EventSource cannot) ----------
function parseSSE(buf, onMsg) {
  var blocks = buf.split("\\n\\n");
  var rest = blocks.pop();
  blocks.forEach(function (blk) {
    var ev = "message", data = "";
    blk.split("\\n").forEach(function (line) {
      if (line.indexOf("event: ") === 0) ev = line.slice(7);
      else if (line.indexOf("data: ") === 0) data += line.slice(6);
    });
    if (data) { try { onMsg(ev, JSON.parse(data)); } catch (e) {} }
  });
  return rest;
}
function openStream(which) {
  if (state[which + "Abort"]) return;
  var ctrl = new AbortController();
  state[which + "Abort"] = ctrl;
  var myId = state.id;
  var path = which === "agent" ? "/api/session/events?id=" : "/api/terminal/events?id=";
  var after = which === "agent" ? state.agentAfter : state.termAfter;
  fetch(path + myId + "&after=" + after, { headers: H, signal: ctrl.signal })
    .then(function (res) {
      if (!res.ok || !res.body) throw new Error("stream http " + res.status);
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
      function step() {
        return reader.read().then(function (r) {
          if (r.done) throw new Error("stream closed");
          buf += dec.decode(r.value, { stream: true });
          buf = parseSSE(buf, function (ev, data) {
            if (state.id !== myId) return;
            if (ev === "line") {
              if (which === "agent") state.agentAfter = Math.max(state.agentAfter, data.seq);
              else state.termAfter = Math.max(state.termAfter, data.seq);
              addLine(data.source, data.at, data.text);
            } else if (ev === "status") {
              setBadge(data.status);
              $("meta").setAttribute("data-status", data.status);
              if (data.waiting_reason) addLine("system", new Date().toISOString(), "agent: " + data.waiting_reason);
            }
          });
          state.backoff = 1000;
          return step();
        });
      }
      return step();
    })
    .catch(function () {
      // dropped (network / server restart): free the slot so the revive
      // poller reconnects at the SAME seq cursor — no dup, no gap
      if (state.id === myId && state[which + "Abort"] === ctrl) state[which + "Abort"] = null;
    });
}
function closeStream(which) {
  var c = state[which + "Abort"];
  if (c) { state[which + "Abort"] = null; try { c.abort(); } catch (e) {} }
}

// The reader loop ends when the stream drops; poll cheaply to revive it.
// Only the LIVE view keeps streams open — the history view is read-only.
setInterval(function () {
  if (state.id == null || state.view !== "live") return;
  if (!state.agentAbort) openStream("agent");
  if (state.termActive && !state.termAbort) openStream("term");
}, 3000);

// ---------- sessions list ----------
function showList() {
  state.id = null; closeStream("agent"); closeStream("term");
  $("detailview").classList.remove("on"); $("listview").classList.add("on");
  $("title").textContent = "TeleOps Sessions"; $("badge").style.display = "none";
  loadList();
}
var listTimer = null;
function loadList() {
  api("/api/sessions").then(function (j) {
    var list = $("list"); list.textContent = "";
    if (!j.sessions.length) {
      var e = document.createElement("div"); e.className = "row";
      e.textContent = "No sessions yet. Create one with ➕ New session.";
      list.appendChild(e);
      return;
    }
    j.sessions.forEach(function (s, i) {
      var r = document.createElement("div"); r.className = "row";
      var l1 = document.createElement("div"); l1.className = "l1";
      var idx = document.createElement("span"); idx.className = "idx"; idx.textContent = "#" + (i + 1);
      var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = s.name;
      var st = document.createElement("span"); st.className = "st-" + s.status; st.textContent = STATUS[s.status] || s.status;
      l1.appendChild(idx); l1.appendChild(nm); l1.appendChild(st);
      var l2 = document.createElement("div"); l2.className = "l2";
      var ag = document.createElement("span"); ag.textContent = "🤖 " + s.agent;
      var pj = document.createElement("span"); pj.textContent = "📁 " + (s.project || "adhoc");
      var ac = document.createElement("span"); ac.textContent = "🕒 " + ago(s.updated_at);
      l2.appendChild(ag); l2.appendChild(pj); l2.appendChild(ac);
      r.appendChild(l1); r.appendChild(l2);
      r.onclick = function () { openSession(s.id); };
      list.appendChild(r);
    });
  }).catch(function (e) { banner(e.message); });
}
function showDetailChrome() {
  $("listview").classList.remove("on"); $("detailview").classList.add("on");
  $("badge").style.display = "";
}
function openSession(id) {
  state.id = id; state.view = "live"; state.agentAfter = 0; state.termAfter = 0;
  closeStream("agent"); closeStream("term");
  banner(null); out.textContent = ""; $("create").classList.remove("on");
  showDetailChrome(); syncViewUI();
  api("/api/session?id=" + id).then(function (j) {
    if (state.id !== id) return;
    $("title").textContent = j.name;
    setBadge(j.status);
    var m = $("meta"); m.textContent = "";
    [["agent", j.agent], ["project", j.project || "adhoc"], ["cwd", j.cwd],
     ["branch", j.branch || "—"], ["host", j.host_id == null ? "local" : "server #" + j.host_id]]
      .forEach(function (kv) {
        var b = document.createElement("b"); b.textContent = kv[0] + ": ";
        m.appendChild(b); m.appendChild(document.createTextNode(kv[1] + "   "));
      });
    j.lines.forEach(function (l) { addLine(l.source, l.at, l.text); });
    if (!j.lines.length) addLine("system", new Date().toISOString(), "no output yet");
    state.agentAfter = j.last_seq; state.termAfter = j.last_seq;
    state.termActive = !!(j.terminal && j.terminal.active);
    syncTermUI();
    openStream("agent");
    if (state.termActive) openStream("term");
  }).catch(function (e) { banner(e.message); });
}

// ---------- detail actions ----------
function syncViewUI() {
  var hist = state.view === "hist";
  $("vlive").classList.toggle("on", !hist);
  $("vhist").classList.toggle("on", hist);
  ["modes", "controls", "sendrow", "hint"].forEach(function (id) {
    $(id).style.display = hist ? "none" : "";
  });
}
$("vlive").onclick = function () {
  if (state.id == null || state.view === "live") return;
  openSession(state.id); // refetch snapshot + reopen streams at coherent cursors
};
$("vhist").onclick = function () {
  if (state.id == null || state.view === "hist") return;
  var myId = state.id;
  closeStream("agent"); closeStream("term");
  state.view = "hist"; syncViewUI();
  out.textContent = "";
  api("/api/session/history?id=" + myId).then(function (j) {
    if (state.id !== myId || state.view !== "hist") return;
    if (!j.lines.length) {
      addLine("system", new Date().toISOString(), "no stored output for this session");
      return;
    }
    j.lines.forEach(function (l) { addLine(l.source, l.at, l.text); });
  }).catch(function (e) { banner(e.message); });
};
$("vdel").onclick = function () {
  if (state.id == null) return;
  if (!confirm("Delete this session and all its stored history? This cannot be undone.")) return;
  api("/api/session/delete?id=" + state.id, { method: "POST" })
    .then(function () { showList(); })
    .catch(function (e) { banner(e.message); });
};
function syncTermUI() {
  $("mterm").classList.toggle("on", state.mode === "term");
  $("mchat").classList.toggle("on", state.mode === "chat");
  $("input").placeholder = state.mode === "term"
    ? (state.termActive ? "Shell command… (cd, git status, npm test…)" : "Press 🖥 to open the shell first")
    : "Message to the agent…";
  $("cc").disabled = !(state.mode === "term" && state.termActive);
}
function setMode(m) {
  if (m === "term" && !state.termActive) {
    api("/api/terminal/start", { method: "POST" }).then(function (st) {
      state.termActive = true; state.mode = "term"; syncTermUI();
      if (!state.termAbort) openStream("term");
      addLine("system", new Date().toISOString(), "shell open in " + (st.cwd || ""));
    }).catch(function (e) { banner(e.message); });
    return;
  }
  state.mode = m; syncTermUI();
}
$("mchat").onclick = function () { setMode("chat"); };
$("mterm").onclick = function () { setMode("term"); };
function send() {
  var el = $("input"), text = el.value;
  if (!text.trim() || state.id == null) return;
  el.value = "";
  var path = state.mode === "term" ? "/api/terminal/input?id=" : "/api/session/input?id=";
  // no local echo in terminal mode: the pane diff streams the command back once
  api(path + state.id, { method: "POST", body: JSON.stringify({ text: text }) })
    .catch(function (e) { banner(e.message); });
}
$("send").onclick = send;
$("input").addEventListener("keydown", function (ev) {
  if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); send(); }
});
$("stop").onclick = function () { act("/api/session/stop"); };
$("resume").onclick = function () { act("/api/session/resume"); };
function act(path) {
  if (state.id == null) return;
  api(path + "?id=" + state.id, { method: "POST" })
    .then(function () { api("/api/session?id=" + state.id).then(function (j) { setBadge(j.status); }); })
    .catch(function (e) { banner(e.message); });
}
$("cc").onclick = function () {
  api("/api/terminal/key?id=" + state.id, { method: "POST", body: JSON.stringify({ key: "C-c" }) })
    .catch(function (e) { banner(e.message); });
};
$("copy").onclick = function () {
  var txt = "";
  out.childNodes.forEach(function (n) { txt += n.textContent + "\\n"; });
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).catch(function () { banner("Copy is unavailable in this client."); });
};
$("back").onclick = showList;
if (tg && tg.BackButton) {
  tg.BackButton.show();
  tg.BackButton.onClick(function () { if (state.id != null) showList(); else tg.close(); });
}

// ---------- create session (goes through the real SessionManager path) ----------
$("newbtn").onclick = function () {
  $("create").classList.toggle("on");
  if (!$("create").classList.contains("on")) return;
  api("/api/meta").then(function (j) {
    var ps = $("cproj"); ps.textContent = "";
    var none = document.createElement("option"); none.value = ""; none.textContent = "(adhoc — admin only)";
    ps.appendChild(none);
    j.projects.forEach(function (p) {
      var o = document.createElement("option"); o.value = String(p.id); o.textContent = p.name; ps.appendChild(o);
    });
    var ag = $("cagent"); ag.textContent = "";
    j.agents.forEach(function (a) {
      var o = document.createElement("option"); o.value = a; o.textContent = a; ag.appendChild(o);
    });
  }).catch(function (e) { banner(e.message); });
};
$("ccancel").onclick = function () { $("create").classList.remove("on"); };
$("cgo").onclick = function () {
  var body = { agent: $("cagent").value, task: $("ctask").value };
  if ($("cproj").value) body.project_id = Number($("cproj").value);
  api("/api/session/create", { method: "POST", body: JSON.stringify(body) })
    .then(function (j) { $("ctask").value = ""; $("create").classList.remove("on"); openSession(j.id); })
    .catch(function (e) { banner(e.message); });
};

// ---------- boot ----------
var startParam = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || "";
var q = new URLSearchParams(location.search).get("session") || "";
var m = startParam.match(/^(?:session_)?(\\d+)$/) || q.match(/^(\\d+)$/);
if (m) { openSession(Number(m[1])); }
else { $("badge").style.display = "none"; showList(); }
listTimer = setInterval(function () { if (state.id == null) loadList(); }, 15000);
</script>
</body>
</html>`;

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
#conn { font-size:11.5px; white-space:nowrap; color:var(--muted); display:none; }
.conn-live { color:var(--ok); }
.conn-idle { color:var(--muted); }
.conn-retry { color:var(--warn); }
main { flex:1; display:flex; flex-direction:column; min-height:0; }
.view { display:none; flex-direction:column; min-height:0; flex:1; }
.view.on { display:flex; }
#banner { display:none; padding:8px 12px; background:#8a1f1f; color:#fff; font-size:13px; }
#banner.on { display:block; }
/* persistent tab bar: Sessions | Terminal */
#navrow { display:flex; gap:6px; padding:8px 12px 0; flex:0 0 auto; }
#navrow button { flex:1; }
#navrow button.on { background:var(--accent); border-color:var(--accent); color:#fff; }
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
/* directory browser overlay */
#browse { display:none; position:fixed; left:8px; right:8px; top:56px; bottom:8px; z-index:30;
  background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:10px 12px;
  flex-direction:column; box-shadow:0 8px 30px rgba(0,0,0,.25); }
#browse.on { display:flex; }
#bpath { font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:var(--muted);
  word-break:break-all; padding:4px 0 8px; border-bottom:1px solid var(--line); flex:0 0 auto; }
#blist { flex:1; overflow-y:auto; padding-top:8px; }
#bbtns { display:flex; gap:6px; padding-top:8px; flex:0 0 auto; }
/* outputs */
#meta, #tmeta { padding:8px 12px; font-size:12.5px; color:var(--muted); background:var(--panel); border-bottom:1px solid var(--line); flex:0 0 auto; }
#meta b, #tmeta b { color:var(--ink); }
#out, #tout { flex:1; overflow-y:auto; padding:10px 12px; margin:0; background:var(--bg);
  font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre-wrap; word-break:break-word; }
#out .ln, #tout .ln { display:block; }
#out .t, #tout .t { color:var(--muted); margin-right:6px; }
#out .s-agent, #tout .s-agent { color:var(--agent); font-weight:600; margin-right:6px; }
#out .s-shell, #tout .s-shell { color:var(--shell); font-weight:600; margin-right:6px; }
#out .s-system, #tout .s-system { color:var(--system); font-weight:600; margin-right:6px; }
#controls { display:flex; gap:6px; padding:8px 12px 0; flex-wrap:wrap; flex:0 0 auto; }
#views { display:flex; gap:6px; padding:8px 12px 0; flex-wrap:wrap; flex:0 0 auto; }
#views button.on { background:var(--accent); border-color:var(--accent); color:#fff; }
#vdel { color:var(--err); }
#tcontrols { display:flex; gap:6px; padding:8px 12px 0; flex-wrap:wrap; flex:0 0 auto; }
#sendrow, #tsendrow { display:flex; gap:6px; padding:8px 12px calc(10px + env(safe-area-inset-bottom)); flex:0 0 auto; }
#sendrow textarea, #tsendrow textarea { flex:1; margin:0; resize:none; min-height:40px; max-height:120px; }
#send, #tsend { align-self:stretch; }
#hint { padding:0 12px 8px; color:var(--muted); font-size:11.5px; flex:0 0 auto; }
</style>
</head>
<body>
<div id="topbar">
  <button id="back" title="Back to sessions">&#8592; Sessions</button>
  <div id="title">TeleOps Sessions</div>
  <div id="conn"></div>
  <div id="badge" class="st-STOPPED">offline</div>
</div>
<div id="banner"></div>
<div id="navrow">
  <button id="tabsessions" class="on">📋 Sessions</button>
  <button id="tabterm">🖥 Linux Terminal</button>
</div>
<main>
  <section id="listview" class="view on">
    <div id="list"></div>
    <div id="create">
      <select id="cproj"></select>
      <input id="ccwd" type="text" readonly placeholder="Run in your own directory — tap Browse…">
      <button id="cbrowse">📁 Browse server directories…</button>
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
    <div id="controls">
      <button id="stop">⏹ Stop</button>
      <button id="resume">▶ Resume</button>
      <button id="copy">⧉ Copy</button>
    </div>
    <div id="sendrow">
      <textarea id="input" rows="1" placeholder="Message to the agent…"></textarea>
      <button id="send" class="primary">Send</button>
    </div>
    <div id="hint">Enter sends · Shift+Enter newline</div>
  </section>
  <section id="termview" class="view">
    <div id="tmeta">personal shell — independent of AI sessions</div>
    <pre id="tout"></pre>
    <div id="tcontrols">
      <button id="tcc">^C Interrupt</button>
      <button id="tcopy">⧉ Copy</button>
      <button id="tstop">⏹ Stop terminal</button>
    </div>
    <div id="tsendrow">
      <textarea id="tinput" rows="1" placeholder="Shell command… (qoder, git status, npm test…)"></textarea>
      <button id="tsend" class="primary">Send</button>
    </div>
    <div id="hint">Real tmux shell: closing this window keeps it running; qoder uses your own stored key.</div>
  </section>
</main>
<div id="browse">
  <div id="bpath"></div>
  <div id="blist"></div>
  <div id="bbtns">
    <button id="bparent">⬆ Parent</button>
    <button id="bsel" class="primary">✔ Select this directory</button>
    <button id="bcancel">Cancel</button>
  </div>
</div>
<script>
"use strict";
var tg = window.Telegram.WebApp;
if (tg) { try { tg.ready(); tg.expand(); } catch (e) {} }
if (tg && tg.colorScheme === "dark") document.body.classList.add("theme-dark");
else document.body.classList.add("theme-light");

var H = { "X-Telegram-Init-Data": (tg && tg.initData) || "", "Content-Type": "application/json" };
var $ = function (id) { return document.getElementById(id); };
var state = { id: null, view: "list", agentAfter: 0, termAfter: 0,
  agentAbort: null, termAbort: null, termOpen: false, pinned: true, tPinned: true, backoff: 1000,
  // REAL link state: up = an open stream got an HTTP 200 body; lastByte/lastData
  // are stamped by actual bytes on the wire — the indicator never simulates.
  up: { agent: false, term: false }, lastByte: 0, lastData: 0 };
var MAX_LINES = 800;
var autoTermDone = false; // boot-to-terminal happens once per app open

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

// ---------- output rendering (shared per-view line builder) ----------
function makeOut(el, isPinned, setPinned) {
  el.addEventListener("scroll", function () {
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  });
  return function (source, at, text) {
    var span = document.createElement("span");
    span.className = "ln";
    var t = document.createElement("span"); t.className = "t"; t.textContent = fmtTime(at);
    var s = document.createElement("span"); s.className = "s-" + source;
    s.textContent = source.toUpperCase();
    var x = document.createElement("span"); x.textContent = text;
    span.appendChild(t); span.appendChild(s); span.appendChild(x);
    el.appendChild(span);
    while (el.childNodes.length > MAX_LINES) el.removeChild(el.firstChild);
    if (isPinned()) el.scrollTop = el.scrollHeight;
  };
}
var addLine = makeOut($("out"), function () { return state.pinned; }, function (v) { state.pinned = v; });
var addTermLine = makeOut($("tout"), function () { return state.tPinned; }, function (v) { state.tPinned = v; });

// ---------- connection / streaming indicator (driven by REAL wire activity) ----------
function updateConnUI() {
  var el = $("conn");
  var watching = (state.view === "detail" && state.id != null) || state.view === "terminal";
  if (!watching) { el.style.display = "none"; el.textContent = ""; return; }
  el.style.display = "";
  var up = state.up.agent || state.up.term;
  if (!up) { el.textContent = "↻ reconnecting…"; el.className = "conn-retry"; return; }
  var now = Date.now();
  if (now - state.lastData < 3000) { el.textContent = "● live"; el.className = "conn-live"; }
  else if (now - state.lastByte < 20000) { el.textContent = "○ connected"; el.className = "conn-idle"; }
  else { el.textContent = "↻ stale…"; el.className = "conn-retry"; }
}
setInterval(updateConnUI, 1000);

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
  var path = which === "agent" ? "/api/session/events?id=" + myId + "&after=" : "/api/terminal/events?after=";
  var after = which === "agent" ? state.agentAfter : state.termAfter;
  fetch(path + after, { headers: H, signal: ctrl.signal })
    .then(function (res) {
      if (!res.ok || !res.body) throw new Error("stream http " + res.status);
      state.up[which] = true;
      state.lastByte = Date.now();
      updateConnUI();
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
      function step() {
        return reader.read().then(function (r) {
          if (r.done) throw new Error("stream closed");
          state.lastByte = Date.now();
          buf += dec.decode(r.value, { stream: true });
          buf = parseSSE(buf, function (ev, data) {
            if (which === "agent" && state.id !== myId) return;
            if (ev === "line") {
              state.lastData = Date.now();
              var emit = which === "agent" ? addLine : addTermLine;
              if (which === "agent") state.agentAfter = Math.max(state.agentAfter, data.seq);
              else state.termAfter = Math.max(state.termAfter, data.seq);
              emit(data.source, data.at, data.text);
            } else if (ev === "status") {
              state.lastData = Date.now();
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
      if (which === "agent" && state.id === myId && state[which + "Abort"] === ctrl) {
        state[which + "Abort"] = null;
        state.up[which] = false;
        updateConnUI();
      } else if (which === "term" && state[which + "Abort"] === ctrl) {
        state[which + "Abort"] = null;
        state.up[which] = false;
        updateConnUI();
      }
    });
}
function closeStream(which) {
  var c = state[which + "Abort"];
  state.up[which] = false;
  if (c) { state[which + "Abort"] = null; try { c.abort(); } catch (e) {} }
  updateConnUI();
}

// The reader loop ends when the stream drops; poll cheaply to revive it.
// Only the ACTIVE view keeps its stream open — the history view is read-only.
setInterval(function () {
  if (state.view === "detail" && state.id != null && !state.agentAbort) openStream("agent");
  if (state.view === "terminal" && state.termOpen && !state.termAbort) openStream("term");
}, 3000);

// ---------- view switching (the persistent bar: Sessions | Terminal) ----------
function showView(name) {
  state.view = name;
  $("listview").classList.toggle("on", name === "list");
  $("detailview").classList.toggle("on", name === "detail");
  $("termview").classList.toggle("on", name === "terminal");
  $("tabsessions").classList.toggle("on", name !== "terminal");
  $("tabterm").classList.toggle("on", name === "terminal");
  updateConnUI();
}

// ---------- sessions list ----------
function showList() {
  state.id = null; closeStream("agent"); closeStream("term");
  banner(null);
  $("badge").style.display = "none";
  $("title").textContent = "TeleOps Sessions";
  showView("list");
  loadList();
}
var listTimer = null;
function loadList() {
  api("/api/sessions").then(function (j) {
    var list = $("list"); list.textContent = "";
    if (!j.sessions.length) {
      var e = document.createElement("div"); e.className = "row";
      e.textContent = "No sessions yet — the Linux Terminal is already open below; create a session with ➕ New session.";
      list.appendChild(e);
      // Requirement: with zero AI sessions, opening the Mini App goes
      // DIRECTLY into the Linux Terminal (once per app open).
      if (!autoTermDone) { autoTermDone = true; openTerminal(); }
      return;
    }
    autoTermDone = true;
    j.sessions.forEach(function (s, i) {
      var r = document.createElement("div"); r.className = "row";
      var l1 = document.createElement("div"); l1.className = "l1";
      var idx = document.createElement("span"); idx.className = "idx"; idx.textContent = "#" + (i + 1);
      var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = s.name;
      var st = document.createElement("span"); st.className = "st-" + s.status; st.textContent = STATUS[s.status] || s.status;
      l1.appendChild(idx); l1.appendChild(nm); l1.appendChild(st);
      var l2 = document.createElement("div"); l2.className = "l2";
      var ag = document.createElement("span"); ag.textContent = "🤖 " + s.agent;
      var pj = document.createElement("span"); pj.textContent = "📁 " + (s.project || "own dir");
      var ac = document.createElement("span"); ac.textContent = "🕒 " + ago(s.updated_at);
      l2.appendChild(ag); l2.appendChild(pj); l2.appendChild(ac);
      r.appendChild(l1); r.appendChild(l2);
      r.onclick = function () { openSession(s.id); };
      list.appendChild(r);
    });
  }).catch(function (e) { banner(e.message); });
}
function showDetailChrome() {
  showView("detail");
  $("badge").style.display = "";
}
function openSession(id) {
  state.id = id; state.agentAfter = 0;
  state.up = { agent: false, term: state.up.term };
  state.lastByte = Date.now(); state.lastData = Date.now();
  closeStream("agent");
  banner(null); $("out").textContent = ""; $("create").classList.remove("on");
  $("vlive").classList.add("on"); $("vhist").classList.remove("on");
  showDetailChrome(); syncViewUI();
  api("/api/session?id=" + id).then(function (j) {
    if (state.id !== id) return;
    $("title").textContent = j.name;
    setBadge(j.status);
    var m = $("meta"); m.textContent = "";
    [["agent", j.agent], ["project", j.project || "own dir"], ["cwd", j.cwd],
     ["branch", j.branch || "—"], ["host", j.host_id == null ? "local" : "server #" + j.host_id]]
      .forEach(function (kv) {
        var b = document.createElement("b"); b.textContent = kv[0] + ": ";
        m.appendChild(b); m.appendChild(document.createTextNode(kv[1] + "   "));
      });
    j.lines.forEach(function (l) { addLine(l.source, l.at, l.text); });
    if (!j.lines.length) addLine("system", new Date().toISOString(), "no output yet");
    state.agentAfter = j.last_seq;
    openStream("agent");
  }).catch(function (e) { banner(e.message); });
}

// ---------- personal Linux Terminal (independent of AI sessions) ----------
function openTerminal() {
  banner(null);
  state.id = null; closeStream("agent");
  $("badge").style.display = "none";
  $("title").textContent = "Linux Terminal";
  showView("terminal");
  api("/api/terminal/start", { method: "POST" }).then(function (st) {
    state.termOpen = true;
    var m = $("tmeta"); m.textContent = "";
    var b = document.createElement("b"); b.textContent = "shell: ";
    m.appendChild(b);
    m.appendChild(document.createTextNode((st.cwd || "") + (st.host_id != null ? "   (server #" + st.host_id + ")" : "   (local)")));
    if (!state.termAbort) openStream("term");
  }).catch(function (e) {
    state.termOpen = false;
    banner(e.message); // every terminal error surfaces to the user
  });
}
$("tabterm").onclick = function () { openTerminal(); };
$("tabsessions").onclick = function () { showList(); };
function sendTerm() {
  var el = $("tinput"), text = el.value;
  if (!text.trim() || !state.termOpen) {
    if (!state.termOpen) banner("Terminal is not open — tap 🖥 Linux Terminal above.");
    return;
  }
  el.value = "";
  // no local echo: the pane diff streams the command back once
  api("/api/terminal/input", { method: "POST", body: JSON.stringify({ text: text }) })
    .catch(function (e) { banner(e.message); });
}
$("tsend").onclick = sendTerm;
$("tinput").addEventListener("keydown", function (ev) {
  if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); sendTerm(); }
});
$("tcc").onclick = function () {
  api("/api/terminal/key", { method: "POST", body: JSON.stringify({ key: "C-c" }) })
    .catch(function (e) { banner(e.message); });
};
$("tstop").onclick = function () {
  api("/api/terminal/stop", { method: "POST" }).then(function () {
    state.termOpen = false; closeStream("term");
    addTermLine("system", new Date().toISOString(), "terminal stopped — tap 🖥 Linux Terminal to reopen");
  }).catch(function (e) { banner(e.message); });
};
$("tcopy").onclick = function () {
  var txt = "";
  $("tout").childNodes.forEach(function (n) { txt += n.textContent + "\\n"; });
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).catch(function () { banner("Copy is unavailable in this client."); });
};

// ---------- detail actions ----------
function syncViewUI() {
  var hist = state.id != null && $("vhist").classList.contains("on");
  ["controls", "sendrow", "hint"].forEach(function (id) {
    $(id).style.display = hist ? "none" : "";
  });
  updateConnUI();
}
$("vlive").onclick = function () {
  if (state.id == null) return;
  $("vlive").classList.add("on"); $("vhist").classList.remove("on");
  if (state.view !== "detail") openSession(state.id);
  else { syncViewUI(); } // already live
};
$("vhist").onclick = function () {
  if (state.id == null) return;
  var myId = state.id;
  closeStream("agent");
  $("vlive").classList.remove("on"); $("vhist").classList.add("on");
  syncViewUI();
  $("out").textContent = "";
  api("/api/session/history?id=" + myId).then(function (j) {
    if (state.id !== myId || !$("vhist").classList.contains("on")) return;
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
function send() {
  var el = $("input"), text = el.value;
  if (!text.trim() || state.id == null) return;
  el.value = "";
  api("/api/session/input?id=" + state.id, { method: "POST", body: JSON.stringify({ text: text }) })
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
$("copy").onclick = function () {
  var txt = "";
  $("out").childNodes.forEach(function (n) { txt += n.textContent + "\\n"; });
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).catch(function () { banner("Copy is unavailable in this client."); });
};
$("back").onclick = showList;
if (tg && tg.BackButton) {
  tg.BackButton.show();
  tg.BackButton.onClick(function () { if (state.view !== "list") showList(); else tg.close(); });
}

// ---------- create session (goes through the real SessionManager path) ----------
$("newbtn").onclick = function () {
  $("create").classList.toggle("on");
  if (!$("create").classList.contains("on")) return;
  api("/api/meta").then(function (j) {
    var ps = $("cproj"); ps.textContent = "";
    var none = document.createElement("option"); none.value = ""; none.textContent = "(no project — use Browse or admin adhoc)";
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

// ---------- directory browser (server FS, restricted to your $HOME) ----------
var browsePath = "", browseParent = null;
function loadBrowse(path) {
  api("/api/browse?path=" + encodeURIComponent(path || "")).then(function (j) {
    if (!j.dirs) { banner("This directory could not be listed."); return; }
    browsePath = j.path; browseParent = j.parent;
    $("bpath").textContent = j.path;
    var list = $("blist"); list.textContent = "";
    if (!j.dirs.length) {
      var e = document.createElement("div"); e.className = "row";
      e.textContent = "(no sub-directories)"; list.appendChild(e);
    }
    j.dirs.forEach(function (d) {
      var r = document.createElement("div"); r.className = "row";
      r.textContent = "📁 " + d;
      r.onclick = function () { loadBrowse(j.path + "/" + d); };
      list.appendChild(r);
    });
  }).catch(function (e) { banner(e.message); });
}
$("cbrowse").onclick = function () {
  $("browse").classList.add("on");
  loadBrowse($("ccwd").value || "");
};
$("bparent").onclick = function () { if (browseParent != null) loadBrowse(browseParent); };
$("bsel").onclick = function () {
  $("ccwd").value = browsePath;
  $("cbrowse").textContent = "📁 Change directory…";
  $("browse").classList.remove("on");
};
$("bcancel").onclick = function () { $("browse").classList.remove("on"); };

$("cgo").onclick = function () {
  var body = { agent: $("cagent").value, task: $("ctask").value };
  var cwd = $("ccwd").value.trim();
  if (cwd) body.cwd = cwd; // chosen directory wins over a project pick
  else if ($("cproj").value) body.project_id = Number($("cproj").value);
  api("/api/session/create", { method: "POST", body: JSON.stringify(body) })
    .then(function (j) { $("ctask").value = ""; $("ccwd").value = ""; $("create").classList.remove("on"); openSession(j.id); })
    .catch(function (e) { banner(e.message); });
};

// ---------- boot ----------
var startParam = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || "";
var q = new URLSearchParams(location.search).get("session") || "";
var tab = new URLSearchParams(location.search).get("tab") || "";
var m = startParam.match(/^(?:session_)?(\\d+)$/) || q.match(/^(\\d+)$/);
if (m) { openSession(Number(m[1])); }
else if (tab === "terminal") { $("badge").style.display = "none"; showList(); openTerminal(); }
else { $("badge").style.display = "none"; showList(); autoTermDone = false; }
listTimer = setInterval(function () { if (state.view === "list") loadList(); }, 15000);
</script>
</body>
</html>`;

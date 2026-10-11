/**
 * The Telegram Mini App page ("Connect Qoder"), served as a single static
 * document by the credential server.
 *
 * Deliberately dependency-free: no external scripts, no analytics, no
 * framework, nothing cached. The PAT is read from the password field, POSTed as
 * JSON over HTTPS with the raw initData in a header, and then wiped from the
 * field. It never enters a URL, a form action, storage, a cookie or a log —
 * there is no console call in this page at all.
 */
export const MINI_APP_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; " +
  // Telegram Web hosts the app in an iframe on telegram.org, so framing is
  // limited to Telegram itself instead of switched off.
  "frame-ancestors https://web.telegram.org https://*.telegram.org";

/** Path the page is served from; must match TELEOPS_MINI_APP_URL's path. */
export const MINI_APP_PATH = "/qoder-key/app";
export const CREDENTIAL_API_PATH = "/qoder-key/api/credential";

export function miniAppHtml(apiPath: string): string {
  const json = JSON.stringify(apiPath).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Connect Qoder</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 18px 28px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg, #ffffff); color: var(--fg, #1c1c1e);
    max-width: 460px; min-height: 100vh; margin-inline: auto;
  }
  h1 { font-size: 19px; margin: 0 0 6px; }
  p { font-size: 14px; line-height: 1.45; margin: 0 0 14px; color: var(--hint, #6b6b70); }
  a { color: var(--link, #2563eb); }
  label { display: block; font-size: 13px; font-weight: 600; margin: 0 0 6px; }
  .field { display: flex; gap: 8px; align-items: stretch; margin-bottom: 14px; }
  input[type=password], input[type=text] {
    flex: 1; min-width: 0; padding: 12px 13px; font-size: 15px; font-family: ui-monospace, monospace;
    color: var(--fg, #1c1c1e); background: var(--input, #f2f2f7);
    border: 1px solid var(--line, #d1d1d6); border-radius: 10px; outline: none;
  }
  input:focus { border-color: var(--link, #2563eb); }
  button {
    font: inherit; border: 0; border-radius: 10px; padding: 12px 16px;
    background: var(--link, #2563eb); color: #fff; cursor: pointer;
  }
  button.ghost { background: transparent; color: var(--link, #2563eb); border: 1px solid var(--line, #d1d1d6); }
  button:disabled { opacity: .55; cursor: default; }
  .toggle { padding: 0 12px; background: var(--input, #f2f2f7); color: var(--hint, #6b6b70);
    border: 1px solid var(--line, #d1d1d6); font-size: 12px; }
  .row { display: flex; gap: 10px; }
  .row button { flex: 1; }
  #status { margin-top: 16px; font-size: 14px; line-height: 1.45; border-radius: 10px; padding: 0; }
  #status:not(:empty) { padding: 12px 13px; }
  #status.ok { background: var(--okbg, #e7f6ec); color: var(--okfg, #14663a); }
  #status.err { background: var(--errbg, #fdecec); color: var(--errfg, #a32020); }
  #status.info { background: var(--input, #f2f2f7); color: var(--hint, #6b6b70); }
  .small { font-size: 12px; color: var(--hint, #6b6b70); margin-top: 16px; }
  @media (prefers-color-scheme: dark) {
    body { --bg:#1c1c1e; --fg:#f2f2f7; --hint:#98989f; --input:#2c2c2e; --line:#3a3a3c;
           --link:#4a8cff; --okbg:#132a1c; --okfg:#7fd39a; --errbg:#2e1616; --errfg:#f2a0a0; }
  }
</style>
</head>
<body>
  <h1>Connect Qoder</h1>
  <p>Paste the Qoder Personal Access Token for <b>your</b> account. TeleOps encrypts it at
     rest and injects it only into sessions that you own — never into another user's session,
     and never back into this chat.</p>
  <p>Don't have one yet? Create it in your
     <a href="https://qoder.com/account/integrations" target="_blank" rel="noreferrer noopener">Qoder account integrations</a>
     page.</p>

  <div id="app">
    <label for="pat">Personal Access Token</label>
    <div class="field">
      <input id="pat" name="qoder-pat" type="password" inputmode="text"
             autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
             data-lpignore="true" data-1p-ignore="true" placeholder="Paste your token">
      <button id="toggle" class="toggle" type="button" aria-label="Show token">show</button>
    </div>
    <div class="row">
      <button id="submit" type="button">Save token</button>
      <button id="cancel" class="ghost" type="button">Cancel</button>
    </div>
    <div id="status" role="status" aria-live="polite"></div>
  </div>
  <p class="small">This form sends the token once, over HTTPS, and forgets it. Nothing is
     stored in your browser. Only its status (configured / missing / invalid) is kept.</p>
<script>
(function () {
  "use strict";
  var API = ${json};
  var field = document.getElementById("pat");
  var submit = document.getElementById("submit");
  var cancel = document.getElementById("cancel");
  var toggle = document.getElementById("toggle");
  var status = document.getElementById("status");
  var busy = false;

  // Telegram hands the app its launch data in the URL fragment, and (when the
  // host injects it) on window.Telegram.WebApp. We read it, never write it.
  function initData() {
    var tw = window.Telegram && window.Telegram.WebApp;
    if (tw && tw.initData) return tw.initData;
    var raw = (location.hash || "").replace(/^#/, "");
    if (!raw) return "";
    try { return new URLSearchParams(raw).get("tgWebAppData") || ""; } catch (e) { return ""; }
  }

  function applyTheme() {
    var tw = window.Telegram && window.Telegram.WebApp;
    var tp = (tw && tw.themeParams) || null;
    if (!tp) {
      try {
        var raw = (location.hash || "").replace(/^#/, "");
        var v = raw && new URLSearchParams(raw).get("tgWebAppThemeParams");
        tp = v ? JSON.parse(v) : null;
      } catch (e) { tp = null; }
    }
    if (!tp) return;
    var map = {
      "--bg": tp.bg_color, "--fg": tp.text_color, "--link": tp.link_color,
      "--hint": tp.hint_color, "--input": tp.secondary_bg_color, "--line": tp.line_color
    };
    for (var k in map) if (typeof map[k] === "string") document.documentElement.style.setProperty(k, map[k]);
  }

  function say(kind, text) {
    status.className = kind;
    status.textContent = text;
  }

  function clearField() {
    field.value = "";
  }

  function setBusy(on) {
    busy = on;
    submit.disabled = on;
    submit.textContent = on ? "Saving\\u2026" : "Save token";
  }

  function close() {
    var tw = window.Telegram && window.Telegram.WebApp;
    if (tw && typeof tw.close === "function") { tw.close(); return; }
    try { window.close(); } catch (e) { /* not a script-opened window */ }
  }

  toggle.addEventListener("click", function () {
    var shown = field.type === "text";
    field.type = shown ? "password" : "text";
    toggle.textContent = shown ? "show" : "hide";
    toggle.setAttribute("aria-label", shown ? "Show token" : "Hide token");
  });

  cancel.addEventListener("click", close);

  field.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") ev.preventDefault(), save();
  });

  // Enter inside a Telegram webview can also arrive as a native "main button" press.
  function save() {
    if (busy) return;
    var pat = field.value.trim();
    if (pat.length < 8) { say("err", "That doesn't look like a token yet \\u2014 paste the full value."); return; }
    var data = initData();
    if (!data) { say("err", "Open this form from the TeleOps bot button \\u2014 it must carry your Telegram session."); return; }
    setBusy(true);
    say("info", "Contacting TeleOps\\u2026");
    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Init-Data": data },
      body: JSON.stringify({ pat: pat }),
      credentials: "omit",
      cache: "no-store",
      mode: "same-origin"
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return { res: res, body: body }; });
    }).then(function (r) {
      var err = r.body && r.body.error;
      if (r.res.ok && r.body && r.body.ok) {
        clearField();
        field.type = "password";
        submit.disabled = true;
        submit.textContent = "Saved";
        say("ok", r.body.message || "\\u2705 Credential saved. You can close this form.");
        return;
      }
      // A refused value is gone; a transport problem leaves it so the user can retry.
      if (err && (err.code === "rejected" || err.code === "invalid_pat")) clearField();
      say("err", (err && err.message) || ("Could not save the token (HTTP " + r.res.status + ")."));
      setBusy(false);
    }).catch(function () {
      say("err", "Network error \\u2014 TeleOps could not be reached. Try again.");
      setBusy(false);
    });
  }

  submit.addEventListener("click", save);

  applyTheme();
  var tw = window.Telegram && window.Telegram.WebApp;
  if (tw) {
    try { if (typeof tw.ready === "function") tw.ready(); if (typeof tw.expand === "function") tw.expand(); } catch (e) {}
    if (tw.BackButton && typeof tw.BackButton.show === "function") {
      try { tw.BackButton.show(); tw.BackButton.onClick(close); } catch (e) {}
    }
  }
  if (!initData()) say("info", "This page is the TeleOps credential form. Open it from the \\u201cOpen Secure Qoder Setup\\u201d button in the bot.");
})();
</script>
</body>
</html>`;
}

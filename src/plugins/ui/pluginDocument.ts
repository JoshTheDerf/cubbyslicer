/**
 * Documents for plugin HTML (windows, dock panels, custom config UIs). Every
 * one renders in `<iframe sandbox="allow-scripts" srcdoc>`: an opaque origin
 * with no access to the app, its storage or cookies, and no network (CSP)
 * unless the plugin was granted origins. What the page gets is OrcaSlicer's:
 *
 *  - the theme contract: `<style id="orca-host-theme-vars">:root{--orca-bg, --orca-fg,
 *    --orca-muted, --orca-border, --orca-accent, --orca-accent-fg, --orca-font}` and
 *    `data-orca-theme` (WebViewHostDialog.cpp host_theme_vars_css);
 *  - windows / docks: Orca's default element styles and the bridge
 *    `window.orca = {postMessage, submit, close, onMessage}` (WebHosting.cpp);
 *  - config UIs: the bridge of plugin-config-ui.js BuildCustomConfigDocument
 *    (`getConfig, saveConfig, restoreDefaults, getContext, onConfig, onTheme`).
 */

export interface ThemeSnapshot { theme: 'dark' | 'light'; css: string }

function resolveColor(expr: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const el = document.createElement('div');
  el.style.display = 'none';
  el.style.color = expr;
  document.body.appendChild(el);
  const c = getComputedStyle(el).color;
  el.remove();
  return c || fallback;
}

/** The live app theme as Orca's CSS variables. */
export function themeSnapshot(): ThemeSnapshot {
  const dark = typeof document === 'undefined' || document.documentElement.classList.contains('dark');
  const font = typeof document !== 'undefined' ? getComputedStyle(document.body).fontFamily.replace(/[<>{};]/g, '') : 'system-ui';
  const css = ':root{'
    + `--orca-bg:${resolveColor('var(--ui-bg)', dark ? '#18181b' : '#ffffff')};`
    + `--orca-fg:${resolveColor('var(--ui-text)', dark ? '#e4e4e7' : '#18181b')};`
    + `--orca-muted:${resolveColor('var(--ui-text-muted)', '#a1a1aa')};`
    + `--orca-border:${resolveColor('var(--ui-border)', dark ? '#3f3f46' : '#e4e4e7')};`
    + `--orca-accent:${resolveColor('var(--ui-primary)', '#009688')};`
    + '--orca-accent-fg:#ffffff;'
    + `--orca-font:${font || 'system-ui,-apple-system,\'Segoe UI\',Roboto,sans-serif'};`
    + `color-scheme:${dark ? 'dark' : 'light'};}`;
  return { theme: dark ? 'dark' : 'light', css };
}

const ELEMENT_DEFAULTS = '<style id="orca-plugin-defaults">'
  + 'html,body{background:var(--orca-bg);color:var(--orca-fg);font-family:var(--orca-font);font-size:13px;}'
  + 'body{margin:0;}'
  + 'h1,h2,h3,h4,h5,h6{color:var(--orca-fg);font-weight:600;}'
  + 'a{color:var(--orca-accent);}'
  + 'hr{border:0;border-top:1px solid var(--orca-border);}'
  + 'button{font:inherit;color:var(--orca-accent-fg);background:var(--orca-accent);border:1px solid var(--orca-accent);border-radius:4px;padding:5px 14px;cursor:pointer;}'
  + 'button:hover{filter:brightness(1.1);}'
  + 'button:disabled{opacity:.5;cursor:default;}'
  + 'input,select,textarea{font:inherit;color:var(--orca-fg);background:var(--orca-bg);border:1px solid var(--orca-border);border-radius:4px;padding:4px 8px;}'
  + 'input:focus,select:focus,textarea:focus{outline:none;border-color:var(--orca-accent);}'
  + 'table{border-collapse:collapse;}'
  + 'th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--orca-border);}'
  + 'th{color:var(--orca-muted);font-weight:600;}'
  + '::-webkit-scrollbar{width:12px;height:12px;}'
  + '::-webkit-scrollbar-thumb{background:var(--orca-border);border-radius:6px;}'
  + '::-webkit-scrollbar-track{background:transparent;}'
  + '</style>';

/** A stored "</script>" would close the tag early: escape "<" (still valid JSON). */
export const inlineJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

export function cspMeta(origins: readonly string[] = []): string {
  const extra = origins.filter((o) => /^https?:\/\/[^\s;'"]+$/.test(o)).join(' ');
  const csp = `default-src 'none'; script-src 'unsafe-inline' ${extra}; style-src 'unsafe-inline' ${extra}; img-src data: blob: ${extra}; font-src data: ${extra}; media-src data: blob:; connect-src ${extra || "'none'"}`;
  return `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/\s+/g, ' ').trim()}">`;
}

const WINDOW_BRIDGE = `<script>
(function () {
  if (window.orca) return;
  var handlers = [];
  function send(kind, data) { parent.postMessage({ __orca: kind, data: data === undefined ? null : data }, '*'); }
  window.orca = {
    postMessage: function (d) { send('message', d); },
    submit: function (d) { send('submit', d); },
    close: function () { send('close'); },
    onMessage: function (cb) { if (typeof cb === 'function') handlers.push(cb); }
  };
  window.__orcaDispatch = function (payload) {
    var data = payload ? payload.data : null;
    for (var i = 0; i < handlers.length; i++) { try { handlers[i](data); } catch (e) {} }
  };
  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data) return;
    var m = e.data;
    if (m.__orca === 'dispatch') window.__orcaDispatch({ data: m.data });
    else if (m.__orca === 'theme' && m.theme) {
      var s = document.getElementById('orca-host-theme-vars');
      if (s) s.textContent = m.theme.css;
      document.documentElement.setAttribute('data-orca-theme', m.theme.theme);
    }
  });
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a && /^https?:/i.test(a.href)) { e.preventDefault(); send('open', a.href); }
  }, true);
})();
<\/script>`;

/** Put host markup at the start of the plugin's document without breaking its doctype. */
export function injectAtStart(html: string, markup: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + markup + html.slice(head.index + head[0].length);
  const root = /<html[^>]*>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + '<head>' + markup + '</head>' + html.slice(root.index + root[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + markup + html.slice(doctype[0].length);
  return '<!doctype html><meta charset="utf-8">' + markup + html;
}

/** A window / dock panel document. */
export function buildWindowDocument(html: string, opts: { origins?: string[] } = {}): string {
  const t = themeSnapshot();
  const markup = `${cspMeta(opts.origins)}<style id="orca-host-theme-vars">${t.css}</style>${ELEMENT_DEFAULTS}`
    + `<script>document.documentElement.setAttribute('data-orca-theme', ${inlineJson(t.theme)});<\/script>${WINDOW_BRIDGE}`;
  return injectAtStart(html, markup);
}

/** A Pages capability's tab (PluginPages.cpp: the bridge has postMessage / onMessage only). */
export function buildPageDocument(html: string, opts: { origins?: string[] } = {}): string {
  const t = themeSnapshot();
  const bridge = WINDOW_BRIDGE.replace("    submit: function (d) { send('submit', d); },\n    close: function () { send('close'); },\n", '');
  const markup = `${cspMeta(opts.origins)}<style id="orca-host-theme-vars">${t.css}</style>${ELEMENT_DEFAULTS}`
    + `<script>document.documentElement.setAttribute('data-orca-theme', ${inlineJson(t.theme)});<\/script>${bridge}`;
  return injectAtStart(html, markup);
}

export interface ConfigContext { scope: 'global' | 'preset'; readOnly: boolean; hasPresetOverride: boolean }

/** plugin-config-ui.js BuildCustomConfigDocument (same API, same message shapes). */
export function buildConfigDocument(html: string, config: unknown, context: ConfigContext): string {
  const theme = themeSnapshot();
  const bridge = `<style id="orca-host-theme-vars"></style>
<script>
(function () {
  var handlers = [];
  var themeHandlers = [];
  var current = ${inlineJson(config === undefined ? {} : config)};
  var context = ${inlineJson(context || {})};
  var theme = ${inlineJson(theme)};

  function applyTheme(next) {
    if (next && typeof next.css === "string") theme = next;
    var style = document.getElementById("orca-host-theme-vars");
    if (style) style.textContent = theme.css;
    if (document.documentElement) document.documentElement.setAttribute("data-orca-theme", theme.theme);
    themeHandlers.forEach(function (handler) {
      try { handler(theme.theme); } catch (e) {}
    });
  }

  window.orca = {
    getConfig: function () { return current; },
    saveConfig: function (cfg) { parent.postMessage({ __orca: "save", config: cfg }, "*"); },
    restoreDefaults: function () { parent.postMessage({ __orca: "restore" }, "*"); },
    getContext: function () { return context; },
    onConfig: function (cb) {
      if (typeof cb !== "function") return;
      handlers.push(cb);
      try { cb(current); } catch (e) {}
    },
    onTheme: function (cb) {
      if (typeof cb !== "function") return;
      themeHandlers.push(cb);
      try { cb(theme.theme); } catch (e) {}
    }
  };

  window.addEventListener("message", function (event) {
    if (!event.data) return;
    if (event.data.__orca === "theme") { applyTheme(event.data.theme); return; }
    if (event.data.__orca !== "config") return;
    current = event.data.config || {};
    if (event.data.context) context = event.data.context;
    handlers.forEach(function (handler) {
      try { handler(current); } catch (e) {}
    });
  });

  applyTheme();
})();
<\/script>`;
  return cspMeta() + bridge + html;
}

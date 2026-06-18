import * as vscode from 'vscode';
import type { LoomClient } from '../api/client';
import type { OpcuaClient } from '../api/opcuaClient';
import { moduleNode } from '../api/nodeId';
import {
  type ModuleDetail,
  type ServiceInfo,
  type DataSection,
  MODULE_STATES,
} from '../api/types';

type WebviewMessage =
  | { type: 'patch'; section: DataSection; ptr: string; value: unknown }
  | { type: 'call'; name: string; body: string }
  | { type: 'reload' }
  | { type: 'saveConfig' }
  | { type: 'loadConfig' }
  | { type: 'refresh' };

/**
 * ModulePanel — the per-module "auto-generated UI": config / recipe / runtime /
 * summary rendered as editable trees plus a service-call panel. This is the
 * VSCode-webview equivalent of the React app's ModuleDetail page, built entirely
 * on the existing REST + WebSocket API (no runtime changes required).
 *
 * One panel per module id; re-opening reveals the existing one.
 */
export class ModulePanel {
  private static readonly open = new Map<string, ModulePanel>();

  static show(
    context: vscode.ExtensionContext,
    client: LoomClient,
    opc: OpcuaClient,
    moduleId: string,
  ): void {
    const existing = this.open.get(moduleId);
    if (existing) { existing.panel.reveal(); return; }
    const panel = new ModulePanel(context, client, opc, moduleId);
    this.open.set(moduleId, panel);
    panel.panel.onDidDispose(() => this.open.delete(moduleId));
  }

  readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private detail: ModuleDetail | undefined;
  private services: ServiceInfo[] = [];
  private connected = false;

  private constructor(
    _context: vscode.ExtensionContext,
    private readonly client: LoomClient,
    private readonly opc: OpcuaClient,
    private readonly moduleId: string,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'loom.modulePanel',
      `Loom: ${moduleId}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = new vscode.ThemeIcon('window');
    this.panel.webview.html = this.html();

    // Stream the live (server-derived) sections via OPC-UA subscriptions.
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m as WebviewMessage)),
      this.opc.monitor(moduleNode(moduleId, 'runtime'), (value, ok) => {
        if (ok && value != null) this.send({ type: 'live', runtime: value });
      }),
      this.opc.monitor(moduleNode(moduleId, 'summary'), (value, ok) => {
        if (ok && value != null) this.send({ type: 'live', summary: value });
      }),
      // config/recipe change rarely, but a hot-reload (new member) or a write
      // from any client must still flow through. The pump's JSON-diff means
      // these only send on an actual change, so subscribing them is near-free.
      this.opc.monitor(moduleNode(moduleId, 'config'), (value, ok) => {
        if (ok && value != null) this.send({ type: 'live', config: value });
      }),
      this.opc.monitor(moduleNode(moduleId, 'recipe'), (value, ok) => {
        if (ok && value != null) this.send({ type: 'live', recipe: value });
      }),
    );
    this.panel.onDidDispose(() => this.dispose());

    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const [detail, services] = await Promise.all([
        this.client.getModule(this.moduleId),
        this.client.getBusServices().catch(() => [] as ServiceInfo[]),
      ]);
      this.detail = detail;
      this.services = services.filter((s) => s.name.startsWith(`${this.moduleId}/`));
      this.connected = true;
    } catch {
      this.connected = false;
    }
    this.send({
      type: 'detail',
      id: this.moduleId,
      connected: this.connected,
      info: this.detail
        ? { state: this.detail.state, version: this.detail.version, className: this.detail.className }
        : null,
      data: this.detail?.data ?? { config: {}, recipe: {}, runtime: {}, summary: {} },
      services: this.services.map((s) => ({ name: s.name, short: s.name.slice(this.moduleId.length + 1), fields: schemaFields(s.schema) })),
      states: MODULE_STATES,
    });
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'patch': {
        try {
          await this.client.patchModuleData(this.moduleId, msg.section, msg.ptr, msg.value);
          // All four sections are now streamed, so the write is reflected by the
          // next subscription tick — no re-fetch needed.
        } catch (e) {
          this.toast(`Write failed: ${(e as Error).message}`, 'err');
        }
        return;
      }
      case 'call': {
        try {
          const r = await this.client.callBusService(msg.name, msg.body);
          this.send({ type: 'callResult', name: msg.name, result: r });
        } catch (e) {
          this.send({ type: 'callResult', name: msg.name, result: { ok: false, error: (e as Error).message } });
        }
        return;
      }
      case 'reload': {
        try {
          const r = await this.client.reloadModule(this.moduleId);
          if (r.ok) { this.toast(`Reloaded ${this.moduleId}.`, 'ok'); await this.refresh(); }
          else { this.toast(`Reload failed: ${r.message ?? 'unknown'}`, 'err'); }
        } catch (e) {
          this.toast(`Reload failed: ${(e as Error).message}`, 'err');
        }
        return;
      }
      case 'saveConfig': {
        try { await this.client.saveModuleConfig(this.moduleId); this.toast('Config saved to disk.', 'ok'); }
        catch (e) { this.toast(`Save failed: ${(e as Error).message}`, 'err'); }
        return;
      }
      case 'loadConfig': {
        try { await this.client.loadModuleConfig(this.moduleId); this.toast('Config loaded from disk.', 'ok'); await this.refresh(); }
        catch (e) { this.toast(`Load failed: ${(e as Error).message}`, 'err'); }
        return;
      }
      case 'refresh':
        await this.refresh();
        return;
    }
  }

  private toast(text: string, kind: 'ok' | 'err'): void {
    this.send({ type: 'toast', text, kind });
  }

  private send(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private html(): string {
    const nonce = makeNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Loom Module</title>
<style>${STYLE}</style>
</head>
<body>
  <header>
    <div class="hdr-main">
      <h2 id="title">…</h2>
      <span id="badge" class="badge"></span>
    </div>
    <span id="meta" class="muted"></span>
    <div class="actions">
      <button id="btn-reload" class="btn">Reload</button>
      <button id="btn-refresh" class="btn">Refresh</button>
    </div>
  </header>

  <nav id="tabs" class="tabs"></nav>

  <div id="disk" class="disk" hidden>
    <button id="btn-loadcfg" class="btn">Load from disk</button>
    <button id="btn-savecfg" class="btn">Save to disk</button>
  </div>

  <main id="body"><p class="muted pad">Loading…</p></main>

  <section id="rpc">
    <h3>Services</h3>
    <div id="rpc-body"><p class="muted pad">—</p></div>
  </section>

  <footer id="toast"></footer>

  <script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
  }
}

// ---------- helpers ----------

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

/** A normalized request-parameter node derived from a service's JSON schema.
 *  Nested objects carry `fields`; leaves carry a type + default for the form. */
interface SvcField {
  key: string;
  type: 'object' | 'array' | 'number' | 'integer' | 'boolean' | 'string';
  default: unknown;
  description?: string;
  enumValues?: unknown[];
  fields?: SvcField[];
}

/** Resolve a glaze JSON schema into a nested SvcField tree, following $ref/$defs.
 *  The webview renders this as a checkbox-gated tree form (no raw JSON). */
function schemaFields(schema: Record<string, unknown> | null): SvcField[] {
  if (!schema) return [];
  const defs = (schema.$defs ?? {}) as Record<string, Record<string, unknown>>;

  const resolve = (def: Record<string, unknown>): Record<string, unknown> => {
    if (def && typeof def.$ref === 'string') {
      const name = def.$ref.split('/').pop() ?? '';
      const r = defs[name];
      if (r) return { ...r, ...def };
    }
    return def;
  };

  const typeOf = (def: Record<string, unknown>): SvcField['type'] => {
    const t = def.type;
    const s = Array.isArray(t) ? String(t[0]) : t != null ? String(t) : def.properties ? 'object' : 'string';
    return s as SvcField['type'];
  };

  const defaultFor = (def: Record<string, unknown>, type: SvcField['type']): unknown => {
    if ('default' in def) return def.default;
    switch (type) {
      case 'number': case 'integer': return 0;
      case 'boolean': return false;
      case 'string': return '';
      case 'array': return [];
      case 'object': return {};
      default: return null;
    }
  };

  const build = (props: Record<string, Record<string, unknown>>): SvcField[] =>
    Object.keys(props).map((key) => {
      const def = resolve(props[key]);
      const type = typeOf(def);
      const field: SvcField = { key, type, default: defaultFor(def, type) };
      if (typeof def.description === 'string') field.description = def.description;
      if (Array.isArray(def.enum)) field.enumValues = def.enum;
      if (type === 'object' && def.properties) {
        field.fields = build(def.properties as Record<string, Record<string, unknown>>);
      }
      return field;
    });

  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  return build(props);
}

// ---------- inlined webview assets ----------

const STYLE = `
:root { color-scheme: var(--vscode-color-scheme, dark light); }
body {
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
  color: var(--vscode-foreground); background: var(--vscode-editor-background);
  margin: 0; padding: 0;
  height: 100vh; display: flex; flex-direction: column; overflow: hidden;
}
header { padding: 12px 18px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex: none; }
.hdr-main { display: flex; align-items: center; gap: 10px; }
header h2 { margin: 0; font-size: 1.05em; font-weight: 600; }
header .actions { display: flex; gap: 8px; margin-top: 8px; }
header #meta { font-size: 0.82em; display: block; margin-top: 4px; }
.badge { font-size: 0.72em; padding: 1px 8px; border-radius: 10px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.badge.state-3 { background: var(--vscode-testing-iconPassed, #4caf50); color: #fff; }
.badge.state-5 { background: var(--vscode-testing-iconFailed, #f44336); color: #fff; }
.badge.off { background: var(--vscode-charts-orange, #d97706); color: #fff; }
.muted { color: var(--vscode-descriptionForeground); }
.pad { padding: 6px 18px; }
.tabs { display: flex; gap: 2px; padding: 8px 18px 0; flex-wrap: wrap; flex: none; }
.tab { background: transparent; color: var(--vscode-foreground); border: none;
  border-bottom: 2px solid transparent; padding: 5px 12px; cursor: pointer;
  font-family: inherit; font-size: 0.9em; }
.tab.active { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
.tab .ro { font-size: 0.72em; color: var(--vscode-descriptionForeground); margin-left: 5px; }
.disk { display: flex; gap: 8px; padding: 8px 18px 0; flex: none; }
main { padding: 10px 18px; flex: 2 1 0; min-height: 0; overflow-y: auto; }
.btn { background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
  color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  border: 1px solid transparent; padding: 3px 10px; cursor: pointer; font-size: 0.85em;
  border-radius: 2px; font-family: inherit; white-space: nowrap; }
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

/* data tree */
.dt-table { display: table; width: 100%; }
.dt-leaf { display: flex; align-items: center; padding: 2px 0; }
.dt-leaf:hover { background: var(--vscode-list-hoverBackground); }
.dt-key-cell { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; }
.dt-arrow { width: 1em; display: inline-block; color: var(--vscode-descriptionForeground); cursor: pointer; }
.dt-arrow-spacer { width: 1em; display: inline-block; }
.dt-key { color: var(--vscode-symbolIcon-propertyForeground, var(--vscode-foreground)); }
.dt-type-hint { font-size: 0.78em; color: var(--vscode-descriptionForeground); margin-left: 6px; }
.dt-val-cell { text-align: right; min-width: 90px; }
.dt-value { background: transparent; border: 1px solid transparent; color: inherit;
  font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; cursor: text;
  padding: 1px 5px; border-radius: 2px; text-align: right; }
.dt-value.editable:hover { border-color: var(--vscode-input-border, var(--vscode-panel-border)); }
.dt-value.dt-number { color: var(--vscode-charts-blue, #4a90e2); }
.dt-value.dt-boolean { color: var(--vscode-charts-purple, #b180d7); }
.dt-value.dt-string { color: var(--vscode-charts-orange, #ce9178); }
.dt-input { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-focusBorder); padding: 1px 5px; font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.9em; text-align: right; border-radius: 2px; width: 120px; }
.dt-branch-row { display: flex; align-items: center; padding: 2px 0; cursor: pointer; }
.dt-children { margin-left: 0; }

/* rpc */
#rpc { padding: 6px 18px 6px; border-top: 1px solid var(--vscode-panel-border);
  flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
#rpc h3 { font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--vscode-descriptionForeground); font-weight: 600; margin: 6px 0 8px; flex: none; }
#rpc-body { flex: 1 1 0; min-height: 0; overflow: hidden; }
.rpc-split { display: flex; gap: 16px; height: 100%; min-height: 0; }
.rpc-list { flex: none; min-width: 140px; max-width: 240px; border-right: 1px solid var(--vscode-panel-border);
  padding-right: 8px; min-height: 0; overflow-y: auto; }
.rpc-call { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; }
.rpc-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; cursor: pointer; border-radius: 2px; }
.rpc-item:hover { background: var(--vscode-list-hoverBackground); }
.rpc-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.rpc-name { font-weight: 600; }
.schema-badge { font-size: 0.68em; padding: 0 6px; border-radius: 8px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.rpc-raw { width: 100%; box-sizing: border-box; background: var(--vscode-input-background);
  color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
  font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; padding: 6px; border-radius: 2px; }

/* service param form */
.svc-form { margin: 4px 0 10px; }
.svc-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.svc-check { margin: 0; cursor: pointer; flex: none; }
.svc-key { flex: 1; min-width: 0; color: var(--vscode-symbolIcon-propertyForeground, var(--vscode-foreground)); }
.svc-key.excluded { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
.svc-type { font-size: 0.74em; color: var(--vscode-descriptionForeground); margin-left: 6px; }
.svc-group-key { font-weight: 600; }
.svc-input, .svc-select { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent); padding: 2px 6px;
  font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; border-radius: 2px;
  width: 150px; text-align: right; }
.svc-input:focus, .svc-select:focus { outline: 1px solid var(--vscode-focusBorder); }
.svc-input:disabled, .svc-select:disabled { opacity: 0.4; }
.svc-children { /* indentation applied inline per depth */ }
.svc-empty { color: var(--vscode-descriptionForeground); font-size: 0.85em; padding: 2px 0 6px; }
.rpc-result { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 2px;
  font-family: var(--vscode-editor-font-family, monospace); font-size: 0.82em; white-space: pre-wrap; overflow-x: auto; }

footer#toast { position: fixed; bottom: 0; left: 0; right: 0; padding: 6px 18px;
  background: var(--vscode-editorWidget-background); border-top: 1px solid var(--vscode-panel-border);
  font-size: 0.85em; min-height: 1.5em; pointer-events: none; opacity: 0; transition: opacity 0.15s; }
footer#toast.show { opacity: 1; }
footer#toast.error { color: var(--vscode-errorForeground); }
footer#toast.ok { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
`;

const SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
  const SECTIONS = [
    { key: 'summary', label: 'Summary', readOnly: true },
    { key: 'runtime', label: 'Runtime' },
    { key: 'config',  label: 'Config' },
    { key: 'recipe',  label: 'Recipe' },
  ];
  let st = {
    connected: false, info: null, states: {},
    data: { config: {}, recipe: {}, runtime: {}, summary: {} },
    services: [],
  };
  let active = 'runtime';
  let selectedSvc = null;
  let toastTimer = null;
  // path string -> value <button> element, for in-place live updates.
  const valueEls = new Map();
  const openBranches = new Set();
  let editingKey = null;

  function post(msg) { vscode.postMessage(msg); }
  function el(tag, attrs) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v != null) e.setAttribute(k, v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function coerce(raw, sample) {
    if (typeof sample === 'number') { const n = Number(raw); return isNaN(n) ? sample : n; }
    if (typeof sample === 'boolean') return raw === 'true' || raw === '1';
    if (sample === null) { try { return JSON.parse(raw); } catch (e) { return raw; } }
    return raw;
  }

  function leafNode(key, value, pathArr, editable, section, depth) {
    const pathStr = pathArr.join('/');
    const valBtn = el('button', {
      class: 'dt-value dt-' + (value === null ? 'null' : typeof value) + (editable ? ' editable' : ''),
      title: editable ? 'Click to edit' : null,
    }, value === null ? 'null' : String(value));
    valueEls.set(section + ':' + pathStr, valBtn);

    if (editable) {
      valBtn.addEventListener('click', function () {
        const input = el('input', { class: 'dt-input', value: value === null ? 'null' : String(value) });
        editingKey = section + ':' + pathStr;
        const cell = valBtn.parentElement;
        cell.replaceChild(input, valBtn);
        input.focus(); input.select();
        function commit() {
          editingKey = null;
          const coerced = coerce(input.value, value);
          post({ type: 'patch', section: section, ptr: '/' + pathStr, value: coerced });
          if (cell.contains(input)) cell.replaceChild(valBtn, input);
          valBtn.textContent = String(coerced);
          value = coerced;
        }
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') commit();
          if (ev.key === 'Escape') { editingKey = null; if (cell.contains(input)) cell.replaceChild(valBtn, input); }
        });
      });
    }
    return el('div', { class: 'dt-leaf' },
      el('span', { class: 'dt-key-cell', style: 'padding-left:' + (depth * 14) + 'px' },
        el('span', { class: 'dt-arrow-spacer' }),
        el('span', { class: 'dt-key', text: key }),
      ),
      el('span', { class: 'dt-val-cell' }, valBtn),
    );
  }

  function branchNode(key, value, pathArr, editable, section, depth) {
    const pathStr = pathArr.join('/');
    const isArr = Array.isArray(value);
    const count = isArr ? value.length : Object.keys(value).length;
    const children = el('div', { class: 'dt-children' });
    const isOpen = openBranches.has(section + ':' + pathStr);
    const arrow = el('span', { class: 'dt-arrow', text: isOpen ? '▾' : '▸' });

    function build() {
      children.innerHTML = '';
      const obj = isArr ? Object.fromEntries(value.map(function (v, i) { return [String(i), v]; })) : value;
      children.appendChild(renderTree(obj, pathArr, editable, section, depth + 1));
    }
    if (isOpen) build();

    const row = el('div', { class: 'dt-branch-row', style: 'padding-left:' + (depth * 14) + 'px' },
      arrow,
      el('span', { class: 'dt-key', text: key }),
      el('span', { class: 'dt-type-hint', text: isArr ? ('[' + count + ']') : ('{' + count + '}') }),
    );
    row.addEventListener('click', function () {
      const k = section + ':' + pathStr;
      if (openBranches.has(k)) { openBranches.delete(k); children.innerHTML = ''; arrow.textContent = '▸'; }
      else { openBranches.add(k); build(); arrow.textContent = '▾'; }
    });
    return el('div', { class: 'dt-branch' }, row, children);
  }

  function renderTree(data, prefix, editable, section, depth) {
    const wrap = el('div', { class: 'data-tree' });
    const leaves = el('div', { class: 'dt-table' });
    const keys = Object.keys(data);
    for (const key of keys) {
      const value = data[key];
      const pathArr = prefix.concat(key);
      const nested = value !== null && typeof value === 'object';
      if (nested) wrap.appendChild(branchNode(key, value, pathArr, editable, section, depth));
      else leaves.appendChild(leafNode(key, value, pathArr, editable, section, depth));
    }
    if (leaves.childNodes.length) wrap.insertBefore(leaves, wrap.firstChild);
    return wrap;
  }

  function currentSection() { return SECTIONS.find(function (s) { return s.key === active; }); }

  function renderBody() {
    const body = document.getElementById('body');
    body.innerHTML = '';
    valueEls.clear();
    if (!st.connected) { body.appendChild(el('p', { class: 'muted pad' }, 'Cannot reach the Loom runtime.')); return; }
    const sec = currentSection();
    const data = st.data[active] || {};
    renderedShape = shapeOf(data);
    if (Object.keys(data).length === 0) { body.appendChild(el('p', { class: 'muted pad' }, 'No fields.')); return; }
    const editable = !sec.readOnly;
    body.appendChild(renderTree(data, [], editable, active, 0));
  }

  // Signature of a section's key structure (paths only, not values). When this
  // changes between live updates the DOM tree is stale (a hot-reload added or
  // removed a member), so we rebuild instead of patching values in place.
  let renderedShape = '';
  function shapeOf(data) {
    const parts = [];
    (function walk(v, p) {
      if (v !== null && typeof v === 'object') {
        const keys = Object.keys(v).sort();
        for (const k of keys) { parts.push(p + '/' + k); walk(v[k], p + '/' + k); }
      }
    })(data, '');
    return parts.join('|');
  }

  // Apply a live section update: full re-render on a structural change (so new
  // members appear / removed ones disappear), otherwise a cheap in-place value
  // patch that preserves scroll position and any field being edited.
  function applyLive(section, data) {
    st.data[section] = data;
    if (active !== section) return;
    if (shapeOf(data) !== renderedShape) renderBody();
    else patchValues(section, data);
  }

  function patchValues(section, data, prefix) {
    prefix = prefix || [];
    for (const key in data) {
      const value = data[key];
      const pathArr = prefix.concat(key);
      if (value !== null && typeof value === 'object') {
        patchValues(section, Array.isArray(value) ? Object.fromEntries(value.map(function (v, i) { return [String(i), v]; })) : value, pathArr);
      } else {
        const k = section + ':' + pathArr.join('/');
        if (k === editingKey) continue; // don't clobber a field being edited
        const node = valueEls.get(k);
        if (node) node.textContent = value === null ? 'null' : String(value);
      }
    }
  }

  function renderTabs() {
    const tabs = document.getElementById('tabs');
    tabs.innerHTML = '';
    for (const s of SECTIONS) {
      tabs.appendChild(el('button', {
        class: 'tab' + (active === s.key ? ' active' : ''),
        onclick: (function (key) { return function () { active = key; renderTabs(); renderBody(); renderDisk(); }; })(s.key),
      }, s.label, s.readOnly ? el('span', { class: 'ro', text: 'read-only' }) : null));
    }
  }

  function renderDisk() {
    document.getElementById('disk').hidden = !(active === 'config');
  }

  function renderHeader() {
    document.getElementById('title').textContent = st.info ? st.info.className || '' : '';
    document.title = 'Loom: ' + (st.info && st.info.className ? st.info.className : '');
    const badge = document.getElementById('badge');
    if (st.info) {
      badge.textContent = st.states[st.info.state] || ('state ' + st.info.state);
      badge.className = 'badge state-' + st.info.state;
    } else { badge.textContent = st.connected ? '' : 'offline'; badge.className = 'badge off'; }
    document.getElementById('meta').textContent = st.info ? ('v' + st.info.version) : '';
  }

  function coerceField(raw, type, fallback) {
    if (type === 'number' || type === 'integer') { const n = Number(raw); return raw === '' || isNaN(n) ? (typeof fallback === 'number' ? fallback : 0) : n; }
    if (type === 'boolean') return raw === 'true' || raw === true;
    if (type === 'array' || type === 'object') { try { return JSON.parse(raw); } catch (e) { return fallback; } }
    return raw;
  }

  function setNested(obj, parts, val) {
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (typeof cur[k] !== 'object' || cur[k] == null) cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = val;
  }

  // Build a checkbox-gated form for a service's parameter tree.
  // 'leaves' collects { path, included(), value() } so Call can assemble the body.
  function buildServiceForm(fields, depth, prefix, leaves) {
    const wrap = el('div', { class: 'svc-children' });
    for (const f of fields) {
      const pathArr = prefix.concat(f.key);
      const indent = depth * 16;
      const check = el('input', { type: 'checkbox', class: 'svc-check' });
      check.checked = true;

      if (f.type === 'object' && f.fields && f.fields.length) {
        const keyLabel = el('span', { class: 'svc-key svc-group-key', text: f.key });
        const row = el('div', { class: 'svc-row', style: 'padding-left:' + indent + 'px' },
          check, keyLabel, el('span', { class: 'svc-type', text: '{' + f.fields.length + '}' }));
        const childLeaves = [];
        const children = buildServiceForm(f.fields, depth + 1, pathArr, childLeaves);
        // The group checkbox toggles every descendant's checkbox + inputs.
        check.addEventListener('change', function () {
          for (const child of childLeaves) child.setEnabled(check.checked);
          keyLabel.classList.toggle('excluded', !check.checked);
        });
        for (const cl of childLeaves) leaves.push(cl);
        wrap.appendChild(row);
        wrap.appendChild(children);
        continue;
      }

      // Leaf field — pick an input by type.
      let input;
      if (f.type === 'boolean') {
        input = el('select', { class: 'svc-select' },
          el('option', { value: 'true', text: 'true' }),
          el('option', { value: 'false', text: 'false' }));
        input.value = f.default ? 'true' : 'false';
      } else if (f.enumValues && f.enumValues.length) {
        input = el('select', { class: 'svc-select' });
        for (const ev of f.enumValues) input.appendChild(el('option', { value: String(ev), text: String(ev) }));
        input.value = String(f.default != null ? f.default : f.enumValues[0]);
      } else {
        const isNum = f.type === 'number' || f.type === 'integer';
        const isJson = f.type === 'array' || f.type === 'object';
        input = el('input', {
          class: 'svc-input',
          type: isNum ? 'number' : 'text',
          value: isJson ? JSON.stringify(f.default) : String(f.default != null ? f.default : ''),
          placeholder: f.description || f.type,
        });
      }

      const keyLabel = el('span', { class: 'svc-key', text: f.key },
        el('span', { class: 'svc-type', text: f.type }));
      const row = el('div', { class: 'svc-row', style: 'padding-left:' + indent + 'px' }, check, keyLabel, input);
      check.addEventListener('change', function () {
        input.disabled = !check.checked;
        keyLabel.classList.toggle('excluded', !check.checked);
      });
      leaves.push({
        path: pathArr,
        included: function () { return check.checked; },
        value: function () { return coerceField(input.value, f.type, f.default); },
        setEnabled: function (on) { check.checked = on; input.disabled = !on; keyLabel.classList.toggle('excluded', !on); },
      });
      wrap.appendChild(row);
    }
    return wrap;
  }

  function renderRpc() {
    const c = document.getElementById('rpc-body');
    c.innerHTML = '';
    if (st.services.length === 0) { c.appendChild(el('p', { class: 'muted pad' }, 'No services registered for this module.')); return; }
    const split = el('div', { class: 'rpc-split' });
    const list = el('div', { class: 'rpc-list' });
    for (const svc of st.services) {
      const hasParams = svc.fields && svc.fields.length;
      list.appendChild(el('div', {
        class: 'rpc-item' + (selectedSvc && selectedSvc.name === svc.name ? ' selected' : ''),
        onclick: (function (s) { return function () { selectedSvc = s; renderRpc(); }; })(svc),
      }, el('span', { class: 'rpc-name', text: svc.short }), hasParams ? el('span', { class: 'schema-badge', text: 'schema' }) : null));
    }
    split.appendChild(list);
    c.appendChild(split);
    if (selectedSvc) {
      const result = el('pre', { class: 'rpc-result' }, '');
      result.hidden = true;
      const leaves = [];
      const fields = selectedSvc.fields || [];
      const form = fields.length
        ? el('div', { class: 'svc-form' }, buildServiceForm(fields, 0, [], leaves))
        : el('div', { class: 'svc-empty' }, 'No parameters — calls with an empty request.');
      const callBtn = el('button', { class: 'btn primary', onclick: function () {
        const out = {};
        for (const lf of leaves) { if (lf.included()) setNested(out, lf.path, lf.value()); }
        post({ type: 'call', name: selectedSvc.name, body: JSON.stringify(out) });
      } }, 'Call');
      const call = el('div', { class: 'rpc-call' }, form, el('div', { style: 'margin-top:6px' }, callBtn), result);
      call.dataset.svc = selectedSvc.name;
      split.appendChild(call);
    }
  }

  function showToast(text, kind) {
    const f = document.getElementById('toast');
    f.textContent = text;
    f.className = 'show ' + (kind === 'err' ? 'error' : kind === 'ok' ? 'ok' : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (f.textContent === text) { f.className = ''; f.textContent = ''; } }, 3000);
  }

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg) return;
    switch (msg.type) {
      case 'detail':
        st.connected = msg.connected; st.info = msg.info; st.states = msg.states;
        st.data = msg.data; st.services = msg.services;
        if (selectedSvc) selectedSvc = st.services.find(function (s) { return s.name === selectedSvc.name; }) || null;
        renderHeader(); renderTabs(); renderDisk(); renderBody(); renderRpc();
        break;
      case 'live':
        if (msg.runtime) applyLive('runtime', msg.runtime);
        if (msg.summary) applyLive('summary', msg.summary);
        if (msg.config)  applyLive('config',  msg.config);
        if (msg.recipe)  applyLive('recipe',  msg.recipe);
        break;
      case 'callResult': {
        const call = document.querySelector('.rpc-call[data-svc="' + msg.name + '"] .rpc-result');
        if (call) { call.hidden = false; call.textContent = JSON.stringify(msg.result, null, 2); }
        break;
      }
      case 'toast':
        showToast(msg.text, msg.kind);
        break;
    }
  });

  document.getElementById('btn-reload').addEventListener('click', function () { post({ type: 'reload' }); });
  document.getElementById('btn-refresh').addEventListener('click', function () { post({ type: 'refresh' }); });
  document.getElementById('btn-savecfg').addEventListener('click', function () { post({ type: 'saveConfig' }); });
  document.getElementById('btn-loadcfg').addEventListener('click', function () { post({ type: 'loadConfig' }); });
})();
`;

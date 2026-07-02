import * as vscode from 'vscode';
import type { LoomClient } from '../api/client';
import type { OpcuaClient } from '../api/opcuaClient';
import { moduleNode } from '../api/nodeId';
import type { DataSection } from '../api/types';

/** A persisted watch row — one scalar field of a module section. */
interface WatchRow {
  id: string;
  moduleId: string;
  section: DataSection;
  path: string;   // '/'-joined field path within the section ('' = whole section, not used for rows)
  label: string;  // display name (defaults to moduleId/path)
}

const STATE_KEY = 'loom.watch.rows';
const SECTIONS: DataSection[] = ['runtime', 'summary', 'config', 'recipe'];

/**
 * WatchPanel — a table-style watch window. Each row is one scalar field watched
 * live over OPC-UA. Add individual variables or whole structures (a structure is
 * broken out into one row per leaf field); remove any row independently.
 *
 * Singleton: re-opening reveals the existing panel.
 */
export class WatchPanel {
  private static current: WatchPanel | undefined;

  static show(context: vscode.ExtensionContext, client: LoomClient, opc: OpcuaClient): void {
    if (this.current) { this.current.panel.reveal(); return; }
    this.current = new WatchPanel(context, client, opc);
    this.current.panel.onDidDispose(() => { this.current = undefined; });
  }

  readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private rows: WatchRow[] = [];
  /** Live monitored-item subscriptions, keyed by row id. */
  private readonly monitors = new Map<string, vscode.Disposable>();
  /** Latest value/type per row id, awaiting a coalesced flush to the webview. */
  private readonly latest = new Map<string, { value: unknown; vtype: string }>();
  private readonly dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: LoomClient,
    private readonly opc: OpcuaClient,
  ) {
    this.rows = context.workspaceState.get<WatchRow[]>(STATE_KEY, []);
    this.panel = vscode.window.createWebviewPanel(
      'loom.watch', 'Loom: Watch', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = new vscode.ThemeIcon('eye');
    this.panel.webview.html = this.html();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m)),
    );
    this.panel.onDidDispose(() => this.dispose());

    for (const r of this.rows) this.startMonitor(r);
    this.sendRows();
  }

  // --- monitoring ----------------------------------------------------------

  private startMonitor(row: WatchRow): void {
    if (this.monitors.has(row.id)) return;
    const node = moduleNode(row.moduleId, row.section, row.path);
    this.monitors.set(row.id, this.opc.monitor(node, (value, ok) => {
      if (!ok) return;
      this.latest.set(row.id, { value, vtype: typeName(value) });
      this.dirty.add(row.id);
      this.scheduleFlush();
    }));
  }

  private stopMonitor(id: string): void {
    this.monitors.get(id)?.dispose();
    this.monitors.delete(id);
    this.latest.delete(id);
    this.dirty.delete(id);
  }

  /** Coalesce high-rate value notifications into one webview update per window. */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty.size === 0) return;
      const updates = [...this.dirty].map((id) => {
        const v = this.latest.get(id);
        return { id, value: v?.value ?? null, vtype: v?.vtype ?? 'null' };
      });
      this.dirty.clear();
      this.send({ type: 'values', updates });
    }, 200);
  }

  // --- messages ------------------------------------------------------------

  private async onMessage(msg: { type: string; id?: string; value?: unknown }): Promise<void> {
    switch (msg.type) {
      case 'ready': this.sendRows(); return;
      case 'add': await this.runAddFlow(); return;
      case 'remove': if (msg.id) this.removeRow(msg.id); return;
      case 'clear': this.clearRows(); return;
      case 'write': if (msg.id) await this.writeRow(msg.id, msg.value); return;
    }
  }

  private async runAddFlow(): Promise<void> {
    let mods;
    try { mods = await this.client.getModules(); }
    catch (e) { vscode.window.showErrorMessage(`Cannot reach Loom: ${(e as Error).message}`); return; }
    if (mods.length === 0) { vscode.window.showInformationMessage('No modules loaded.'); return; }

    const modPick = await vscode.window.showQuickPick(
      mods.map((m) => ({ label: m.id, description: `${m.className} v${m.version}`, id: m.id })),
      { placeHolder: 'Module to watch' },
    );
    if (!modPick) return;

    const section = await vscode.window.showQuickPick(SECTIONS, {
      placeHolder: 'Section', }) as DataSection | undefined;
    if (!section) return;

    let data: Record<string, unknown>;
    try { data = await this.client.getModuleData(modPick.id, section); }
    catch (e) { vscode.window.showErrorMessage(`Read failed: ${(e as Error).message}`); return; }

    const { leaves, branches } = flatten(data);
    if (leaves.length === 0) { vscode.window.showInformationMessage('No fields in this section.'); return; }

    type Item = vscode.QuickPickItem & { path: string; nodeKind: 'leaf' | 'branch' };
    const items: Item[] = [
      ...branches.map((b): Item => ({
        label: `$(symbol-structure) ${b.path}`, description: `structure · ${b.count} field(s)`,
        path: b.path, nodeKind: 'branch',
      })),
      ...leaves.map((l): Item => ({
        label: `$(symbol-field) ${l.path}`, description: fmtValue(l.value),
        path: l.path, nodeKind: 'leaf',
      })),
    ];
    const picks = (await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: `Select variables / structures from ${modPick.id}/${section}`,
      matchOnDescription: true,
    })) as Item[] | undefined;
    if (!picks || picks.length === 0) return;

    // Expand any picked structure into its leaf fields; union with picked leaves.
    const paths = new Set<string>();
    for (const p of picks) {
      if (p.nodeKind === 'leaf') paths.add(p.path);
      else for (const l of leaves) if (l.path === p.path || l.path.startsWith(p.path + '/')) paths.add(l.path);
    }

    const existing = new Set(this.rows.filter((r) => r.moduleId === modPick.id && r.section === section).map((r) => r.path));
    let added = 0;
    for (const path of paths) {
      if (existing.has(path)) continue;
      const row: WatchRow = { id: makeId(), moduleId: modPick.id, section, path, label: `${modPick.id}/${path}` };
      this.rows.push(row);
      this.startMonitor(row);
      added++;
    }
    if (added > 0) { void this.persist(); this.sendRows(); }
  }

  private removeRow(id: string): void {
    this.stopMonitor(id);
    this.rows = this.rows.filter((r) => r.id !== id);
    void this.persist();
    this.sendRows();
  }

  private clearRows(): void {
    for (const id of [...this.monitors.keys()]) this.stopMonitor(id);
    this.rows = [];
    void this.persist();
    this.sendRows();
  }

  private async writeRow(id: string, value: unknown): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    try {
      const ok = await this.client.patchModuleData(row.moduleId, row.section, '/' + row.path, value);
      if (!ok.ok) vscode.window.showWarningMessage(`Write rejected for ${row.label}.`);
    } catch (e) {
      vscode.window.showErrorMessage(`Write failed: ${(e as Error).message}`);
    }
  }

  private persist(): Thenable<void> {
    return this.context.workspaceState.update(STATE_KEY, this.rows);
  }

  private sendRows(): void {
    this.send({
      type: 'rows',
      rows: this.rows.map((r) => {
        const v = this.latest.get(r.id);
        return {
          id: r.id, module: r.moduleId, section: r.section, path: r.path, label: r.label,
          value: v?.value ?? null, vtype: v?.vtype ?? '',
        };
      }),
    });
  }

  private send(msg: unknown): void { void this.panel.webview.postMessage(msg); }

  private dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const d of this.monitors.values()) d.dispose();
    this.monitors.clear();
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
<title>Loom Watch</title>
<style>${STYLE}</style>
</head>
<body>
  <header>
    <h2>Watch</h2>
    <span id="count" class="muted"></span>
    <div class="actions">
      <button id="btn-add" class="btn primary">Add…</button>
      <button id="btn-clear" class="btn">Clear all</button>
    </div>
  </header>
  <main>
    <table id="tbl">
      <thead><tr><th>Module</th><th>Field</th><th class="val">Value</th><th>Type</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <p id="empty" class="muted pad">No watched variables — click “Add…”.</p>
  </main>
  <script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
  }
}

// --- helpers ---------------------------------------------------------------

function makeId(): string { return Math.random().toString(36).slice(2, 10); }

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let r = ''; for (let i = 0; i < 32; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

function typeName(v: unknown): string { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'object') return Array.isArray(v) ? `[${(v as unknown[]).length}]` : '{…}';
  return String(v);
}

/** Walk a section object into scalar leaves and the structures that contain them. */
function flatten(data: Record<string, unknown>): {
  leaves: { path: string; value: unknown }[];
  branches: { path: string; count: number }[];
} {
  const leaves: { path: string; value: unknown }[] = [];
  const branches: { path: string; count: number }[] = [];
  const walk = (v: unknown, prefix: string): void => {
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      if (prefix) branches.push({ path: prefix, count: entries.length });
      for (const [k, val] of entries) walk(val, prefix ? `${prefix}/${k}` : k);
    } else if (prefix) {
      leaves.push({ path: prefix, value: v });
    }
  };
  walk(data, '');
  return { leaves, branches };
}

// --- inlined webview assets ------------------------------------------------

const STYLE = `
:root { color-scheme: var(--vscode-color-scheme, dark light); }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
  color: var(--vscode-foreground); background: var(--vscode-editor-background);
  margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
header { display: flex; align-items: center; gap: 12px; padding: 10px 16px;
  border-bottom: 1px solid var(--vscode-panel-border); flex: none; }
header h2 { margin: 0; font-size: 1.05em; font-weight: 600; }
header .actions { margin-left: auto; display: flex; gap: 8px; }
.muted { color: var(--vscode-descriptionForeground); }
.pad { padding: 12px 16px; }
main { flex: 1; min-height: 0; overflow: auto; }
.btn { background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
  color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  border: 1px solid transparent; padding: 3px 10px; cursor: pointer; font-size: 0.85em;
  border-radius: 2px; font-family: inherit; }
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
thead th { position: sticky; top: 0; background: var(--vscode-editor-background);
  text-align: left; font-weight: 600; color: var(--vscode-descriptionForeground);
  font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
th.val, td.val { text-align: right; }
tbody td { padding: 4px 12px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
tbody tr:hover { background: var(--vscode-list-hoverBackground); }
.col-mod { color: var(--vscode-descriptionForeground); }
.col-field { font-family: var(--vscode-editor-font-family, monospace); }
.col-val { font-family: var(--vscode-editor-font-family, monospace); text-align: right; }
.col-val.editable { cursor: text; }
.col-val.t-number { color: var(--vscode-charts-blue, #4a90e2); }
.col-val.t-boolean { color: var(--vscode-charts-purple, #b180d7); }
.col-val.t-string { color: var(--vscode-charts-orange, #ce9178); }
.col-type { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.val-input { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-focusBorder); padding: 1px 5px; border-radius: 2px;
  font-family: var(--vscode-editor-font-family, monospace); font-size: 0.95em; text-align: right; width: 120px; }
.rm { background: transparent; border: none; color: var(--vscode-descriptionForeground);
  cursor: pointer; padding: 0 4px; font-size: 1em; }
.rm:hover { color: var(--vscode-errorForeground); }
`;

const SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
  let rows = [];
  let editingId = null;

  function post(m) { vscode.postMessage(m); }
  function el(tag, attrs) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v != null) e.setAttribute(k, v);
    }
    for (let i = 2; i < arguments.length; i++) { const c = arguments[i]; if (c == null || c === false) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return e;
  }
  function fmt(v) { return v === null || v === undefined ? 'null' : String(v); }

  function coerce(raw, vtype) {
    if (vtype === 'number') { const n = Number(raw); return isNaN(n) ? raw : n; }
    if (vtype === 'boolean') return raw === 'true' || raw === '1';
    return raw;
  }

  function render() {
    const tb = document.getElementById('rows');
    tb.innerHTML = '';
    document.getElementById('count').textContent = rows.length ? rows.length + ' row(s)' : '';
    document.getElementById('empty').style.display = rows.length ? 'none' : '';
    document.getElementById('tbl').style.display = rows.length ? '' : 'none';
    for (const r of rows) {
      const valCell = el('td', { class: 'col-val editable t-' + (r.vtype || ''), 'data-id': r.id, title: 'Double-click to edit' }, fmt(r.value));
      valCell.addEventListener('dblclick', function () { beginEdit(valCell, r); });
      tb.appendChild(el('tr', { 'data-id': r.id },
        el('td', { class: 'col-mod' }, r.module),
        el('td', { class: 'col-field' }, r.path),
        valCell,
        el('td', { class: 'col-type' }, r.vtype || ''),
        el('td', {}, el('button', { class: 'rm', title: 'Remove', onclick: function () { post({ type: 'remove', id: r.id }); } }, '✕')),
      ));
    }
  }

  function beginEdit(cell, r) {
    editingId = r.id;
    const input = el('input', { class: 'val-input', value: fmt(r.value) });
    cell.textContent = ''; cell.appendChild(input); input.focus(); input.select();
    function commit() {
      editingId = null;
      post({ type: 'write', id: r.id, value: coerce(input.value, r.vtype) });
      cell.textContent = input.value;
    }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') commit();
      if (ev.key === 'Escape') { editingId = null; cell.textContent = fmt(r.value); }
    });
  }

  function applyValues(updates) {
    for (const u of updates) {
      const r = rows.find(function (x) { return x.id === u.id; });
      if (!r) continue;
      r.value = u.value; r.vtype = u.vtype;
      if (editingId === u.id) continue; // don't clobber a field being edited
      const cell = document.querySelector('td.col-val[data-id="' + u.id + '"]');
      if (cell) { cell.textContent = fmt(u.value); cell.className = 'col-val editable t-' + (u.vtype || ''); }
    }
  }

  window.addEventListener('message', function (e) {
    const m = e.data; if (!m) return;
    if (m.type === 'rows') { rows = m.rows; render(); }
    else if (m.type === 'values') { applyValues(m.updates); }
  });

  document.getElementById('btn-add').addEventListener('click', function () { post({ type: 'add' }); });
  document.getElementById('btn-clear').addEventListener('click', function () { post({ type: 'clear' }); });
  post({ type: 'ready' });
})();
`;

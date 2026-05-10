import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { LoomClient } from '../api/client';
import type { LiveStream, LiveUpdate } from '../api/liveStream';
import {
  type ModuleInfo,
  type AvailableModule,
  MODULE_STATES,
} from '../api/types';

type WebviewMessage =
  | { type: 'instantiate'; so: string; id: string }
  | { type: 'remove';      id: string }
  | { type: 'reload';      id: string }
  | { type: 'saveConfig';  id: string }
  | { type: 'loadConfig';  id: string }
  | { type: 'inspect';     id: string }
  | { type: 'upload' }
  | { type: 'refresh' };

const REFRESH_MS = 5000;

export class ManagementPanel {
  private static current: ManagementPanel | undefined;

  static show(context: vscode.ExtensionContext, client: LoomClient, live: LiveStream): void {
    if (this.current) { this.current.panel.reveal(); return; }
    this.current = new ManagementPanel(context, client, live);
    this.current.panel.onDidDispose(() => { this.current = undefined; });
  }

  readonly panel: vscode.WebviewPanel;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private modules: ModuleInfo[] = [];
  private available: AvailableModule[] = [];
  private connected = false;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly client: LoomClient,
    private readonly live: LiveStream,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'loom.management',
      'Loom: Manage Modules',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      },
    );
    this.panel.iconPath = new vscode.ThemeIcon('settings-gear');
    this.panel.webview.html = this.html();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m as WebviewMessage)),
      this.live.onLive((u) => this.applyLive(u)),
    );
    this.panel.onDidDispose(() => this.dispose());

    void this.refreshAll();
    this.pollTimer = setInterval(() => void this.refreshAll(), REFRESH_MS);
  }

  private async refreshAll(): Promise<void> {
    const [modulesResult, availableResult] = await Promise.allSettled([
      this.client.getModules(),
      this.client.getAvailableModules(),
    ]);
    if (modulesResult.status === 'fulfilled') {
      this.modules = modulesResult.value;
      this.connected = true;
    } else {
      this.modules = [];
      this.connected = false;
    }
    this.available = availableResult.status === 'fulfilled' ? availableResult.value : [];
    this.send({
      type: 'state',
      modules: this.modules,
      available: this.available,
      states: MODULE_STATES,
      connected: this.connected,
    });
  }

  private applyLive(u: LiveUpdate): void {
    let mutated = false;
    for (const m of this.modules) {
      const live = u.modules[m.id];
      if (!live?.stats) continue;
      m.stats = live.stats;
      mutated = true;
    }
    if (mutated) this.send({ type: 'liveStats', modules: this.modules });
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'instantiate': {
        try {
          await this.client.instantiateModule(msg.so, msg.id);
          this.toast(`Instantiated ${msg.id}.`, 'ok');
          await this.refreshAll();
        } catch (e) {
          this.toast(`Instantiate failed: ${(e as Error).message}`, 'err');
        }
        return;
      }
      case 'remove': {
        const confirm = await vscode.window.showWarningMessage(
          `Remove module instance '${msg.id}'?`, { modal: true }, 'Remove',
        );
        if (confirm !== 'Remove') return;
        try {
          await this.client.removeModule(msg.id);
          this.toast(`Removed ${msg.id}.`, 'ok');
          await this.refreshAll();
        } catch (e) {
          this.toast(`Remove failed: ${(e as Error).message}`, 'err');
        }
        return;
      }
      case 'reload': {
        try {
          const r = await this.client.reloadModule(msg.id);
          if (r.ok) { this.toast(`Reloaded ${msg.id}.`, 'ok'); await this.refreshAll(); }
          else { this.toast(`Reload failed: ${r.message ?? 'unknown'}`, 'err'); }
        } catch (e) {
          this.toast(`Reload failed: ${(e as Error).message}`, 'err');
        }
        return;
      }
      case 'saveConfig': {
        try {
          await this.client.saveModuleConfig(msg.id);
          this.toast(`Saved ${msg.id} config.`, 'ok');
        } catch (e) {
          this.toast(`Save failed: ${(e as Error).message}`, 'err');
        }
        return;
      }
      case 'loadConfig': {
        try {
          await this.client.loadModuleConfig(msg.id);
          this.toast(`Loaded ${msg.id} config from disk.`, 'ok');
          await this.refreshAll();
        } catch (e) {
          this.toast(`Load failed: ${(e as Error).message}`, 'err');
        }
        return;
      }
      case 'inspect': {
        await vscode.commands.executeCommand('loom.modules.inspect');
        return;
      }
      case 'upload': {
        const uri = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'Module': ['so', 'dylib', 'dll'] },
          title: 'Select module to upload',
        });
        if (!uri || uri.length === 0) return;
        try {
          const filename = path.basename(uri[0].fsPath);
          const content = await fs.readFile(uri[0].fsPath);
          const r = await this.client.uploadModule(filename, content);
          if (r.ok) { this.toast(`Uploaded ${filename}.`, 'ok'); await this.refreshAll(); }
          else { this.toast(`Upload failed: ${r.error ?? 'unknown'}`, 'err'); }
        } catch (e) {
          this.toast(`Upload failed: ${(e as Error).message}`, 'err');
        }
        return;
      }
      case 'refresh':
        await this.refreshAll();
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
    if (this.pollTimer) clearInterval(this.pollTimer);
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
<title>Loom Modules</title>
<style>${STYLE}</style>
</head>
<body>
  <header>
    <h2>Loom Module Management</h2>
    <span id="status" class="muted">…</span>
    <div class="actions">
      <button id="btn-refresh">Refresh</button>
      <button id="btn-upload" class="primary">Upload .so / .dylib…</button>
    </div>
  </header>

  <section>
    <h3>Instances <span class="count" id="count-instances">0</span></h3>
    <div id="instances" class="list"><p class="muted pad">Loading…</p></div>
  </section>

  <section>
    <h3>Available <span class="count" id="count-available">0</span></h3>
    <div id="available" class="list"><p class="muted pad">Loading…</p></div>
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

// ---------- inlined webview assets ----------

const STYLE = `
:root { color-scheme: var(--vscode-color-scheme, dark light); }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0; padding: 0 0 32px 0;
}
header {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
header h2 { margin: 0; font-size: 1.05em; font-weight: 600; }
header #status { font-size: 0.85em; }
header .actions { margin-left: auto; display: flex; gap: 8px; }
section { padding: 6px 18px 14px; }
section h3 {
  font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--vscode-descriptionForeground);
  font-weight: 600; margin: 14px 0 8px;
  display: flex; align-items: center; gap: 8px;
}
.count {
  font-size: 0.95em; padding: 1px 7px; border-radius: 10px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  text-transform: none; letter-spacing: 0; font-weight: 500;
}
.list { display: flex; flex-direction: column; gap: 1px; }
.row {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 12px;
  background: var(--vscode-editorWidget-background, transparent);
  border-radius: 2px;
}
.row + .row { border-top: 1px solid var(--vscode-panel-border); }
.row:hover { background: var(--vscode-list-hoverBackground); }
.row .main { flex: 1; min-width: 0; }
.row .title { display: flex; align-items: baseline; gap: 8px; }
.row .id { font-weight: 600; }
.row .badge {
  font-size: 0.72em; padding: 1px 7px; border-radius: 10px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.row.state-3 .badge { background: var(--vscode-testing-iconPassed, #4caf50); color: #fff; }
.row.state-5 .badge { background: var(--vscode-testing-iconFailed, #f44336); color: #fff; }
.row.state-2 .badge { background: var(--vscode-charts-blue, #4a90e2); color: #fff; }
.row.state-4 .badge { background: var(--vscode-charts-orange, #d97706); color: #fff; }
.row .meta { font-size: 0.85em; }
.muted { color: var(--vscode-descriptionForeground); }
.pad { padding: 4px 12px; }
.row .actions { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.btn {
  background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
  color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  border: 1px solid transparent;
  padding: 3px 10px;
  cursor: pointer;
  font-size: 0.85em;
  border-radius: 2px;
  font-family: inherit;
  white-space: nowrap;
}
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
.btn.danger {
  color: var(--vscode-errorForeground);
  border-color: var(--vscode-errorForeground);
  background: transparent;
}
.btn.danger:hover {
  background: color-mix(in srgb, var(--vscode-errorForeground) 18%, transparent);
}
input[type="text"] {
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 3px 7px; font-size: 0.85em; min-width: 140px;
  border-radius: 2px;
  font-family: inherit;
}
input[type="text"]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 0; }
footer#toast {
  position: fixed; bottom: 0; left: 0; right: 0;
  padding: 6px 18px;
  background: var(--vscode-editorWidget-background);
  border-top: 1px solid var(--vscode-panel-border);
  font-size: 0.85em;
  min-height: 1.5em;
  pointer-events: none;
  opacity: 0; transition: opacity 0.15s;
}
footer#toast.show { opacity: 1; pointer-events: auto; }
footer#toast.error { color: var(--vscode-errorForeground); }
footer#toast.ok { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
`;

const SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
  let st = { modules: [], available: [], states: {}, connected: false };
  let toastTimer = null;

  function el(tag, attrs) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function btn(label, onClick, kind) {
    return el('button', { class: 'btn' + (kind ? ' ' + kind : ''), onclick: onClick }, label);
  }

  function post(msg) { vscode.postMessage(msg); }

  function render() {
    document.getElementById('status').textContent = st.connected ? 'Connected' : 'Disconnected';
    document.getElementById('status').className = st.connected ? '' : 'muted';
    document.getElementById('count-instances').textContent = st.modules.length;
    document.getElementById('count-available').textContent = st.available.length;
    renderInstances();
    renderAvailable();
  }

  function renderInstances() {
    const container = document.getElementById('instances');
    container.innerHTML = '';
    if (!st.connected) {
      container.appendChild(el('p', { class: 'muted pad' }, 'Cannot reach Loom runtime.'));
      return;
    }
    if (st.modules.length === 0) {
      container.appendChild(el('p', { class: 'muted pad' }, 'No modules instantiated yet. See Available below.'));
      return;
    }
    const sorted = st.modules.slice().sort(function (a, b) { return a.id.localeCompare(b.id); });
    for (const m of sorted) {
      const stateName = st.states[m.state] || ('state ' + m.state);
      const stats = m.stats || {};
      const meta = (m.className || '?') + ' v' + (m.version || '?')
        + (stats.lastCycleTimeUs != null ? ' · ' + stats.lastCycleTimeUs + 'µs' : '')
        + (stats.overrunCount != null ? ' · overruns ' + stats.overrunCount : '')
        + (m.cyclicClass ? ' · ' + m.cyclicClass : '');
      const row = el('div', { class: 'row instance state-' + m.state },
        el('div', { class: 'main' },
          el('div', { class: 'title' },
            el('span', { class: 'id' }, m.id),
            el('span', { class: 'badge' }, stateName),
          ),
          el('div', { class: 'meta muted' }, meta),
        ),
        el('div', { class: 'actions' },
          btn('Inspect',  function () { post({ type: 'inspect',    id: m.id }); }),
          btn('Reload',   function () { post({ type: 'reload',     id: m.id }); }),
          btn('Save',     function () { post({ type: 'saveConfig', id: m.id }); }),
          btn('Load',     function () { post({ type: 'loadConfig', id: m.id }); }),
          btn('Remove',   function () { post({ type: 'remove',     id: m.id }); }, 'danger'),
        ),
      );
      container.appendChild(row);
    }
  }

  function renderAvailable() {
    const container = document.getElementById('available');
    container.innerHTML = '';
    if (!st.connected) return;
    if (st.available.length === 0) {
      container.appendChild(el('p', { class: 'muted pad' }, 'No .so / .dylib files in the configured module directory.'));
      return;
    }
    const sorted = st.available.slice().sort(function (a, b) {
      return a.className.localeCompare(b.className);
    });
    const usedIds = new Set(st.modules.map(function (m) { return m.id; }));
    for (const a of sorted) {
      const baseId = (a.className || a.filename).toLowerCase();
      let suggestedId = baseId, n = 2;
      while (usedIds.has(suggestedId)) { suggestedId = baseId + n; n++; }
      const idInput = el('input', { type: 'text', placeholder: 'instance id', value: suggestedId });
      function fire() {
        const id = idInput.value.trim();
        if (!id) return;
        post({ type: 'instantiate', so: a.filename, id: id });
      }
      idInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') fire();
      });
      const row = el('div', { class: 'row available' },
        el('div', { class: 'main' },
          el('div', { class: 'title' },
            el('span', { class: 'id' }, a.className),
            el('span', { class: 'meta muted' }, 'v' + a.version),
          ),
          el('div', { class: 'meta muted' }, a.filename),
        ),
        el('div', { class: 'actions' },
          idInput,
          btn('Instantiate', fire, 'primary'),
        ),
      );
      container.appendChild(row);
    }
  }

  function showToast(text, kind) {
    const f = document.getElementById('toast');
    f.textContent = text;
    f.className = 'show ' + (kind === 'err' ? 'error' : kind === 'ok' ? 'ok' : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (f.textContent === text) { f.className = ''; f.textContent = ''; }
    }, 3000);
  }

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg) return;
    switch (msg.type) {
      case 'state':
        st.modules = msg.modules;
        st.available = msg.available;
        st.states = msg.states;
        st.connected = msg.connected;
        render();
        break;
      case 'liveStats':
        st.modules = msg.modules;
        renderInstances();
        break;
      case 'toast':
        showToast(msg.text, msg.kind);
        break;
    }
  });

  document.getElementById('btn-refresh').addEventListener('click', function () { post({ type: 'refresh' }); });
  document.getElementById('btn-upload').addEventListener('click', function () { post({ type: 'upload' }); });
})();
`;

import * as vscode from 'vscode';
import type { FaultSource } from '../api/faultSource';

type WebviewMessage =
  | { type: 'gotoFrame'; file: string; line: number }
  | { type: 'refresh' };

/**
 * FaultPanel — the crash-report viewer. Renders one fault report (GET
 * /api/faults/<id>): header (module/phase/reason/build), the symbolized stack as
 * clickable rows that jump to source, and the captured data sections. Mirrors
 * ModulePanel's structure (one panel per fault id, inlined HTML/CSP/script).
 *
 * On a dev build the runtime symbolizes in-process, so frames already carry
 * file:line and clicking opens source — no tools, no config. Stripped builds
 * still show the breadcrumb + raw addresses (symbolize offline / via symbolsDir).
 */
export class FaultPanel {
  private static readonly open = new Map<string, FaultPanel>();

  static show(context: vscode.ExtensionContext, source: FaultSource, faultId: string): void {
    const key = `${source.id}::${faultId}`;
    const existing = this.open.get(key);
    if (existing) { existing.panel.reveal(); return; }
    const panel = new FaultPanel(context, source, faultId);
    this.open.set(key, panel);
    panel.panel.onDidDispose(() => this.open.delete(key));
  }

  readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    _context: vscode.ExtensionContext,
    private readonly source: FaultSource,
    private readonly faultId: string,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'loom.faultPanel',
      `Loom Crash: ${faultId}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = new vscode.ThemeIcon('error');
    this.panel.webview.html = this.html();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m as WebviewMessage)),
    );
    this.panel.onDidDispose(() => this.dispose());

    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const detail = await this.source.detail(this.faultId);
      if (detail) this.send({ type: 'report', detail });
      else this.send({ type: 'error', message: `Report '${this.faultId}' not found in ${this.source.detailText}` });
    } catch (e) {
      this.send({ type: 'error', message: (e as Error).message });
    }
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'gotoFrame':
        await vscode.commands.executeCommand('loom.faults.openFrame', { file: msg.file, line: msg.line });
        return;
      case 'refresh':
        await this.refresh();
        return;
    }
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
<title>Loom Crash Report</title>
<style>${STYLE}</style>
</head>
<body>
  <header>
    <div class="hdr-main">
      <h2 id="title">Crash report…</h2>
      <span id="badge" class="badge"></span>
    </div>
    <span id="reason" class="reason"></span>
    <span id="meta" class="muted"></span>
    <div class="actions"><button id="btn-refresh" class="btn">Refresh</button></div>
  </header>

  <main>
    <section>
      <h3>Stack trace</h3>
      <div id="frames"><p class="muted pad">Loading…</p></div>
    </section>
    <section id="sections-wrap">
      <h3>Captured values</h3>
      <div id="sections"></div>
    </section>
  </main>

  <script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
  }
}

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
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
  color: var(--vscode-foreground); background: var(--vscode-editor-background);
  margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden;
}
header { padding: 12px 18px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex: none; }
.hdr-main { display: flex; align-items: center; gap: 10px; }
header h2 { margin: 0; font-size: 1.05em; font-weight: 600; }
header .actions { display: flex; gap: 8px; margin-top: 8px; }
header .reason { display: block; margin-top: 6px; color: var(--vscode-errorForeground); font-family: var(--vscode-editor-font-family, monospace); }
header #meta { font-size: 0.82em; display: block; margin-top: 4px; }
.badge { font-size: 0.72em; padding: 1px 8px; border-radius: 10px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.badge.signal { background: var(--vscode-testing-iconFailed, #f44336); color: #fff; }
.badge.exception { background: var(--vscode-charts-orange, #d97706); color: #fff; }
.muted { color: var(--vscode-descriptionForeground); }
.pad { padding: 6px 18px; }
main { flex: 1 1 0; min-height: 0; overflow-y: auto; padding: 6px 18px 24px; }
section h3 { font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--vscode-descriptionForeground); font-weight: 600; margin: 14px 0 6px; }
.btn { background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
  color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  border: 1px solid transparent; padding: 3px 10px; cursor: pointer; font-size: 0.85em;
  border-radius: 2px; font-family: inherit; }
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }

/* frames */
.frame { display: flex; gap: 10px; align-items: baseline; padding: 3px 6px; border-radius: 2px;
  font-family: var(--vscode-editor-font-family, monospace); font-size: 0.88em; }
.frame.clickable { cursor: pointer; }
.frame.clickable:hover { background: var(--vscode-list-hoverBackground); }
.frame .idx { color: var(--vscode-descriptionForeground); min-width: 2.2em; text-align: right; }
.frame .fn { color: var(--vscode-symbolIcon-functionForeground, var(--vscode-foreground)); }
.frame .loc { color: var(--vscode-textLink-foreground); }
.frame .addr { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-left: auto; }
.frame.unresolved .fn { color: var(--vscode-descriptionForeground); }

/* sections */
.sec { margin: 4px 0; }
.sec-name { font-weight: 600; cursor: pointer; user-select: none; }
.sec-name .arrow { display: inline-block; width: 1em; color: var(--vscode-descriptionForeground); }
pre.json { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 2px; margin: 4px 0 0;
  font-family: var(--vscode-editor-font-family, monospace); font-size: 0.82em; white-space: pre-wrap; overflow-x: auto; }
pre.raw { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 2px;
  font-family: var(--vscode-editor-font-family, monospace); font-size: 0.82em; white-space: pre-wrap; }
`;

const SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
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

  function renderFrames(frames) {
    const host = document.getElementById('frames');
    host.innerHTML = '';
    if (!frames || frames.length === 0) {
      host.appendChild(el('p', { class: 'muted pad' }, 'No stack frames in this report.'));
      return;
    }
    for (const f of frames) {
      const hasLoc = f.file && f.line > 0;
      const fn = f.function || '<unknown>';
      const row = el('div', { class: 'frame' + (hasLoc ? ' clickable' : '') + (f.function ? '' : ' unresolved') },
        el('span', { class: 'idx', text: '#' + f.idx }),
        el('span', { class: 'fn', text: fn }),
        hasLoc ? el('span', { class: 'loc', text: shortPath(f.file) + ':' + f.line }) : null,
        el('span', { class: 'addr', text: f.address || '' }),
      );
      if (hasLoc) {
        row.title = f.file + ':' + f.line;
        row.addEventListener('click', function () { post({ type: 'gotoFrame', file: f.file, line: f.line }); });
      }
      host.appendChild(row);
    }
  }

  function shortPath(p) {
    const parts = String(p).split(/[\\\\/]/);
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
  }

  function renderSections(sections, raw) {
    const wrap = document.getElementById('sections-wrap');
    const host = document.getElementById('sections');
    host.innerHTML = '';
    if (raw != null) {
      wrap.querySelector('h3').textContent = 'Raw report';
      host.appendChild(el('pre', { class: 'raw' }, String(raw)));
      return;
    }
    if (!sections) {
      host.appendChild(el('p', { class: 'muted pad' }, 'No captured values (signal-path crash — live state was not snapshotted).'));
      return;
    }
    const order = ['runtime', 'summary', 'config', 'recipe'];
    let any = false;
    for (const name of order) {
      const val = sections[name];
      if (val == null) continue;
      any = true;
      const body = el('pre', { class: 'json' }, JSON.stringify(val, null, 2));
      body.hidden = name !== 'runtime'; // expand the most useful one
      const arrow = el('span', { class: 'arrow', text: body.hidden ? '▸' : '▾' });
      const name_ = el('div', { class: 'sec-name' }, arrow, document.createTextNode(' ' + name));
      name_.addEventListener('click', function () {
        body.hidden = !body.hidden;
        arrow.textContent = body.hidden ? '▸' : '▾';
      });
      host.appendChild(el('div', { class: 'sec' }, name_, body));
    }
    if (!any) host.appendChild(el('p', { class: 'muted pad' }, 'No captured values.'));
  }

  function render(d) {
    const who = d.breadcrumb && d.breadcrumb.module ? d.breadcrumb.module : '(runtime)';
    const phase = d.breadcrumb ? d.breadcrumb.phase : '';
    document.getElementById('title').textContent = who + (phase ? ' · ' + phase : '');
    document.title = 'Loom Crash: ' + who;
    const badge = document.getElementById('badge');
    badge.textContent = d.kind || '';
    badge.className = 'badge ' + (d.kind || '');
    document.getElementById('reason').textContent = d.reason || '';
    const bits = [];
    if (d.breadcrumb && d.breadcrumb.class) bits.push('class ' + d.breadcrumb.class);
    if (d.breadcrumb && typeof d.breadcrumb.cycle === 'number') bits.push('cycle ' + d.breadcrumb.cycle);
    if (typeof d.signalOrCode === 'number' && d.signalOrCode !== 0) bits.push('code 0x' + (d.signalOrCode >>> 0).toString(16));
    if (d.build) bits.push('sdk ' + d.build.sdkVersion, 'git ' + d.build.gitSha, d.build.buildType);
    document.getElementById('meta').textContent = bits.join(' · ');
    renderFrames(d.frames);
    renderSections(d.sections, d.raw);
  }

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'report') render(msg.detail);
    else if (msg.type === 'error') {
      document.getElementById('title').textContent = 'Cannot load report';
      document.getElementById('reason').textContent = msg.message || '';
    }
  });

  document.getElementById('btn-refresh').addEventListener('click', function () { post({ type: 'refresh' }); });
})();
`;

import * as vscode from 'vscode';
import type { LoomClient } from '../api/client';
import type { SystemMetrics } from '../api/types';

/**
 * SystemPanel — live readout of the runtime process's memory + CPU usage
 * (GET /api/system: 1s samples, ~10min history kept server-side).
 *
 * The panel polls while open and redraws entirely from the server's history
 * each time — no client-side accumulation, so it's always correct after
 * reconnects/runtime restarts. Charts are plain canvas (no framework),
 * following WatchPanel's inline-HTML pattern.
 *
 * Singleton: re-opening reveals the existing panel.
 */
export class SystemPanel {
  private static current: SystemPanel | undefined;

  static show(client: LoomClient): void {
    if (this.current) { this.current.panel.reveal(); return; }
    this.current = new SystemPanel(client);
    this.current.panel.onDidDispose(() => { this.current = undefined; });
  }

  readonly panel: vscode.WebviewPanel;
  private timer: NodeJS.Timeout | null = null;

  private constructor(private readonly client: LoomClient) {
    this.panel = vscode.window.createWebviewPanel(
      'loom.system', 'Loom: System Metrics', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = new vscode.ThemeIcon('pulse');
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose());

    // Match the runtime's 1s sample cadence; one small GET per tick while open.
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 1000);
  }

  private async poll(): Promise<void> {
    let data: SystemMetrics | undefined;
    try { data = await this.client.getSystem(); } catch { /* unreachable → offline frame */ }
    void this.panel.webview.postMessage(
      data ? { type: 'metrics', data } : { type: 'offline' },
    );
  }

  private dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
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
<title>Loom System Metrics</title>
<style>${STYLE}</style>
</head>
<body>
  <header>
    <h2>System</h2>
    <span id="conn" class="muted">connecting…</span>
    <div class="stats">
      <div class="stat"><span class="label">Memory</span><span id="rss" class="value">—</span></div>
      <div class="stat"><span class="label">Peak</span><span id="peak" class="value">—</span></div>
      <div class="stat"><span class="label">CPU</span><span id="cpu" class="value">—</span></div>
      <div class="stat"><span class="label">Uptime</span><span id="uptime" class="value">—</span></div>
    </div>
  </header>
  <main>
    <section>
      <h3>Memory (RSS)</h3>
      <canvas id="memChart"></canvas>
    </section>
    <section>
      <h3>CPU (% of machine)</h3>
      <canvas id="cpuChart"></canvas>
    </section>
  </main>
  <script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let r = ''; for (let i = 0; i < 32; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

// --- inlined webview assets ------------------------------------------------

const STYLE = `
:root { color-scheme: var(--vscode-color-scheme, dark light); }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
  color: var(--vscode-foreground); background: var(--vscode-editor-background);
  margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
header { display: flex; align-items: center; gap: 16px; padding: 10px 16px;
  border-bottom: 1px solid var(--vscode-panel-border); flex: none; flex-wrap: wrap; }
header h2 { margin: 0; font-size: 1.05em; font-weight: 600; }
.muted { color: var(--vscode-descriptionForeground); }
.muted.bad { color: var(--vscode-errorForeground); }
.stats { margin-left: auto; display: flex; gap: 20px; }
.stat { display: flex; flex-direction: column; align-items: flex-end; }
.stat .label { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--vscode-descriptionForeground); }
.stat .value { font-family: var(--vscode-editor-font-family, monospace); font-size: 1.05em; }
main { flex: 1; min-height: 0; overflow: auto; padding: 8px 16px 16px; }
section { margin-top: 8px; }
section h3 { margin: 6px 0; font-size: 0.78em; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); }
canvas { width: 100%; height: 160px; display: block;
  border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
`;

const SCRIPT = `
(function () {
  let last = null;
  let offline = false;

  function fmtBytes(b) {
    if (b >= 1024 * 1024 * 1024) return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function fmtUptime(s) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
          m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + sec + 's';
    return sec + 's';
  }
  function css(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  // Minimal time-series line chart: fixed-height canvas, x = sample time,
  // y auto-scaled (memory) or 0-100 with auto-zoom-in (cpu). Redrawn whole
  // each frame from the server-held history -- ~600 points, trivial.
  function drawChart(canvas, points, opts) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const fg = css('--vscode-descriptionForeground', '#888');
    const line = opts.color;
    const padL = 46, padR = 8, padT = 8, padB = 16;
    const cw = w - padL - padR, ch = h - padT - padB;

    let maxY = opts.fixedMax || 0;
    if (!maxY) { for (const p of points) if (p.v > maxY) maxY = p.v; maxY = maxY * 1.15 || 1; }
    else {
      // fixedMax acts as a cap; zoom in when the signal is far below it.
      let peak = 0; for (const p of points) if (p.v > peak) peak = p.v;
      maxY = Math.min(maxY, Math.max(peak * 1.3, opts.minSpan || 1));
    }

    ctx.strokeStyle = fg; ctx.globalAlpha = 0.25; ctx.lineWidth = 1;
    ctx.font = '10px ' + css('--vscode-font-family', 'sans-serif');
    ctx.fillStyle = fg;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (ch * i) / 4;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      const val = maxY * (1 - i / 4);
      ctx.globalAlpha = 0.8;
      ctx.fillText(opts.fmt(val), 4, y + 3);
      ctx.globalAlpha = 0.25;
    }
    ctx.globalAlpha = 1;

    if (points.length < 2) return;
    const t0 = points[0].t, t1 = points[points.length - 1].t;
    const span = Math.max(t1 - t0, 1);
    ctx.strokeStyle = line; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const x = padL + ((points[i].t - t0) / span) * cw;
      const y = padT + ch - Math.min(points[i].v / maxY, 1) * ch;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // x-axis: time window label
    ctx.fillStyle = fg; ctx.globalAlpha = 0.8;
    const mins = Math.round(span / 60000);
    ctx.fillText(mins >= 1 ? 'last ' + mins + ' min' : 'last ' + Math.round(span / 1000) + ' s',
                 padL, h - 4);
    ctx.globalAlpha = 1;
  }

  function render() {
    const conn = document.getElementById('conn');
    if (offline || !last) {
      conn.textContent = offline ? 'runtime unreachable' : 'connecting…';
      conn.className = offline ? 'muted bad' : 'muted';
      if (!last) return;
    } else {
      conn.textContent = 'live';
      conn.className = 'muted';
    }
    document.getElementById('rss').textContent    = fmtBytes(last.rssBytes);
    document.getElementById('peak').textContent   = fmtBytes(last.peakRssBytes);
    document.getElementById('cpu').textContent    = last.cpuPercent.toFixed(1) + '%';
    document.getElementById('uptime').textContent = fmtUptime(last.uptimeSec);

    const mem = last.history.map(function (s) { return { t: s.ts, v: s.rssBytes }; });
    const cpu = last.history.map(function (s) { return { t: s.ts, v: s.cpuPercent }; });
    drawChart(document.getElementById('memChart'), mem, {
      color: css('--vscode-charts-blue', '#4a90e2'), fmt: fmtBytes,
    });
    drawChart(document.getElementById('cpuChart'), cpu, {
      color: css('--vscode-charts-purple', '#b180d7'),
      fixedMax: 100, minSpan: 5,
      fmt: function (v) { return v.toFixed(v < 10 ? 1 : 0) + '%'; },
    });
  }

  window.addEventListener('message', function (e) {
    const m = e.data; if (!m) return;
    if (m.type === 'metrics') { last = m.data; offline = false; render(); }
    else if (m.type === 'offline') { offline = true; render(); }
  });
  window.addEventListener('resize', render);
})();
`;

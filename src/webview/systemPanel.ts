import * as vscode from 'vscode';
import type { LoomClient } from '../api/client';
import type { SystemMetrics } from '../api/types';

/**
 * SystemPanel — live readout of the runtime process's memory + CPU usage
 * (GET /api/system: 1s samples, ~10min history kept server-side).
 *
 * Charts:
 *  - Memory: RSS and live-heap (heapUsedBytes) as two lines. The gap between
 *    them is allocator page retention — RSS climbing with flat heap is normal
 *    ratcheting; both climbing together is a real leak. Heap series is hidden
 *    when the runtime doesn't report it (older runtime / no platform reader).
 *  - CPU: % of machine, capped at 100 but zoomed into the signal when idle.
 *  - Change/10s: ± bar chart of net RSS and heap deltas per 10s bucket — makes
 *    growth episodes visible long after the absolute lines have flattened.
 *
 * The panel polls while open and redraws entirely from the server's history
 * each time — no client-side accumulation, so it's always correct after
 * reconnects/runtime restarts. Plain canvas, following WatchPanel's
 * inline-HTML pattern. Singleton: re-opening reveals the existing panel.
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
      <div class="stat" id="heapStat"><span class="label">Live Heap</span><span id="heap" class="value">—</span></div>
      <div class="stat"><span class="label">Peak</span><span id="peak" class="value">—</span></div>
      <div class="stat"><span class="label">CPU</span><span id="cpu" class="value">—</span></div>
      <div class="stat"><span class="label">Uptime</span><span id="uptime" class="value">—</span></div>
    </div>
  </header>
  <main>
    <section>
      <h3>Memory <span id="memLegend" class="legend"></span></h3>
      <canvas id="memChart"></canvas>
    </section>
    <section>
      <h3>Change / 10s <span id="diffLegend" class="legend"></span></h3>
      <canvas id="diffChart"></canvas>
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
  letter-spacing: 0.05em; color: var(--vscode-descriptionForeground);
  display: flex; align-items: center; gap: 10px; }
.legend { font-weight: 400; text-transform: none; letter-spacing: 0; }
.legend .key { display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; }
.legend .swatch { display: inline-block; width: 10px; height: 3px; border-radius: 1px; }
canvas { width: 100%; height: 150px; display: block;
  border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
`;

const SCRIPT = `
(function () {
  let last = null;
  let offline = false;

  function fmtBytes(b) {
    const a = Math.abs(b);
    if (a >= 1024 * 1024 * 1024) return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    if (a >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
    return (b / 1024).toFixed(0) + ' KB';
  }
  function fmtSigned(b) { return (b > 0 ? '+' : '') + fmtBytes(b); }
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
  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return null;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }
  function legend(el, keys) {
    el.innerHTML = '';
    for (const k of keys) {
      const span = document.createElement('span'); span.className = 'key';
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = k.color;
      span.appendChild(sw); span.appendChild(document.createTextNode(k.label));
      el.appendChild(span);
    }
  }

  // Multi-series time line chart. series: [{points:[{t,v}], color}]. Y auto-
  // scales to the max across all series (or opts.fixedMax cap with zoom-in).
  function drawChart(canvas, series, opts) {
    const c = setupCanvas(canvas);
    if (!c) return;
    const { ctx, w, h } = c;
    const fg = css('--vscode-descriptionForeground', '#888');
    const padL = 46, padR = 8, padT = 8, padB = 16;
    const cw = w - padL - padR, ch = h - padT - padB;

    let peak = 0, t0 = Infinity, t1 = -Infinity;
    for (const s of series) for (const p of s.points) {
      if (p.v > peak) peak = p.v;
      if (p.t < t0) t0 = p.t;
      if (p.t > t1) t1 = p.t;
    }
    let maxY = opts.fixedMax ? Math.min(opts.fixedMax, Math.max(peak * 1.3, opts.minSpan || 1))
                             : (peak * 1.15 || 1);

    ctx.font = '10px ' + css('--vscode-font-family', 'sans-serif');
    for (let i = 0; i <= 4; i++) {
      const y = padT + (ch * i) / 4;
      ctx.strokeStyle = fg; ctx.globalAlpha = 0.25; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = fg; ctx.globalAlpha = 0.8;
      ctx.fillText(opts.fmt(maxY * (1 - i / 4)), 4, y + 3);
    }
    ctx.globalAlpha = 1;

    const span = Math.max(t1 - t0, 1);
    for (const s of series) {
      if (s.points.length < 2) continue;
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < s.points.length; i++) {
        const x = padL + ((s.points[i].t - t0) / span) * cw;
        const y = padT + ch - Math.min(s.points[i].v / maxY, 1) * ch;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.fillStyle = fg; ctx.globalAlpha = 0.8;
    const mins = Math.round(span / 60000);
    ctx.fillText(mins >= 1 ? 'last ' + mins + ' min' : 'last ' + Math.round(span / 1000) + ' s',
                 padL, h - 4);
    ctx.globalAlpha = 1;
  }

  // ± grouped bar chart around a center zero line. buckets: [{t, deltas:[b0,b1]}]
  // (bytes; one bar per series per bucket). Y is symmetric about zero.
  function drawDiffChart(canvas, buckets, colors) {
    const c = setupCanvas(canvas);
    if (!c) return;
    const { ctx, w, h } = c;
    const fg = css('--vscode-descriptionForeground', '#888');
    const padL = 52, padR = 8, padT = 8, padB = 16;
    const cw = w - padL - padR, ch = h - padT - padB;

    let maxAbs = 0;
    for (const b of buckets) for (const d of b.deltas) if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
    if (!maxAbs) maxAbs = 1024; // all-zero window: show a 1KB scale, flat
    maxAbs *= 1.15;

    ctx.font = '10px ' + css('--vscode-font-family', 'sans-serif');
    // gridlines at +max, +max/2, 0, -max/2, -max
    for (let i = 0; i <= 4; i++) {
      const frac = 1 - i / 2;              // 1, .5, 0, -.5, -1
      const y = padT + (ch * i) / 4;
      ctx.strokeStyle = fg; ctx.globalAlpha = i === 2 ? 0.6 : 0.25; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = fg; ctx.globalAlpha = 0.8;
      ctx.fillText(fmtSigned(maxAbs * frac), 4, y + 3);
    }
    ctx.globalAlpha = 1;

    if (!buckets.length) return;
    const zeroY = padT + ch / 2;
    const slot = cw / buckets.length;
    const nSeries = colors.length;
    const barW = Math.max(1, (slot * 0.7) / nSeries);
    for (let i = 0; i < buckets.length; i++) {
      for (let s = 0; s < nSeries; s++) {
        const d = buckets[i].deltas[s];
        if (d === undefined) continue;
        const x = padL + i * slot + slot * 0.15 + s * barW;
        const hh = Math.min(Math.abs(d) / maxAbs, 1) * (ch / 2);
        ctx.fillStyle = colors[s];
        if (d >= 0) ctx.fillRect(x, zeroY - hh, barW, Math.max(hh, d > 0 ? 1 : 0));
        else        ctx.fillRect(x, zeroY, barW, Math.max(hh, 1));
      }
    }
  }

  // Net change per fixed time bucket: v(last in bucket) - v(last of previous
  // bucket), so bars sum to the total move across the window.
  function bucketize(history, keys, bucketMs) {
    if (history.length < 2) return [];
    const out = [];
    let prev = history[0];
    let bucketEnd = history[0].ts + bucketMs;
    let lastInBucket = null;
    for (const s of history) {
      if (s.ts >= bucketEnd) {
        if (lastInBucket) {
          out.push({ t: bucketEnd, deltas: keys.map((k) => (lastInBucket[k] || 0) - (prev[k] || 0)) });
          prev = lastInBucket;
        }
        while (s.ts >= bucketEnd) bucketEnd += bucketMs;
        lastInBucket = s;
      } else {
        lastInBucket = s;
      }
    }
    return out;
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

    const blue   = css('--vscode-charts-blue', '#4a90e2');
    const green  = css('--vscode-charts-green', '#89d185');
    const purple = css('--vscode-charts-purple', '#b180d7');
    // heapUsedBytes is 0/absent on runtimes without the allocator reader —
    // treat "never nonzero in the window" as unsupported and hide the series.
    const hasHeap = (last.heapUsedBytes || 0) > 0 || last.history.some(function (s) { return (s.heapUsedBytes || 0) > 0; });

    document.getElementById('rss').textContent    = fmtBytes(last.rssBytes);
    document.getElementById('peak').textContent   = fmtBytes(last.peakRssBytes);
    document.getElementById('cpu').textContent    = last.cpuPercent.toFixed(1) + '%';
    document.getElementById('uptime').textContent = fmtUptime(last.uptimeSec);
    document.getElementById('heap').textContent   = hasHeap ? fmtBytes(last.heapUsedBytes) : 'n/a';
    document.getElementById('heapStat').title     = hasHeap
      ? 'Live heap allocations (allocator bookkeeping). RSS above this is allocator page retention.'
      : 'This runtime does not report allocator stats (older runtime or unsupported platform).';

    const memSeries = [{ points: last.history.map(function (s) { return { t: s.ts, v: s.rssBytes }; }), color: blue }];
    const memKeys = [{ label: 'RSS', color: blue }];
    if (hasHeap) {
      memSeries.push({ points: last.history.map(function (s) { return { t: s.ts, v: s.heapUsedBytes || 0 }; }), color: green });
      memKeys.push({ label: 'live heap', color: green });
    }
    legend(document.getElementById('memLegend'), memKeys);
    drawChart(document.getElementById('memChart'), memSeries, { fmt: fmtBytes });

    const diffKeys = hasHeap ? ['rssBytes', 'heapUsedBytes'] : ['rssBytes'];
    const diffColors = hasHeap ? [blue, green] : [blue];
    legend(document.getElementById('diffLegend'),
           hasHeap ? [{ label: 'Δ RSS', color: blue }, { label: 'Δ heap', color: green }]
                   : [{ label: 'Δ RSS', color: blue }]);
    drawDiffChart(document.getElementById('diffChart'), bucketize(last.history, diffKeys, 10000), diffColors);

    drawChart(document.getElementById('cpuChart'),
      [{ points: last.history.map(function (s) { return { t: s.ts, v: s.cpuPercent }; }), color: purple }],
      { fixedMax: 100, minSpan: 5, fmt: function (v) { return v.toFixed(v < 10 ? 1 : 0) + '%'; } });
  }

  window.addEventListener('message', function (e) {
    const m = e.data; if (!m) return;
    if (m.type === 'metrics') { last = m.data; offline = false; render(); }
    else if (m.type === 'offline') { offline = true; render(); }
  });
  window.addEventListener('resize', render);
})();
`;

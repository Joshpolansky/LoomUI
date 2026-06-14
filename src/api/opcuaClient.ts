import * as vscode from 'vscode';
import WebSocket, { type RawData } from 'ws';

import { serverUrl } from '../util/paths';

/** A value notification for a monitored node. `ok` is the OPC-UA status (Good). */
export type MonitorCallback = (value: unknown, ok: boolean) => void;

interface Monitor {
  nodeId: string;
  clientHandle: number;
  monitoredItemId?: number;   // server-assigned; needed to DELETE the item
  readonly cbs: Set<MonitorCallback>;
  lastValue?: unknown;        // replayed to late subscribers
  hasValue: boolean;
}

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;
const KEEPALIVE_MS = 10_000;
const SESSION_TIMEOUT_MS = 30_000;
const DEFAULT_PUBLISHING_INTERVAL_MS = 500;

interface PushNotification {
  clientHandle: number;
  value: unknown;
  status?: { code?: number; symbol?: string };
}
interface PushFrame {
  sessionId?: number;
  subscriptionId?: number;
  DataNotifications?: PushNotification[];
}

/**
 * Thin client for the Loom runtime's OPC-UA-over-REST facade (mapp
 * Connect-compatible). Owns one session + one subscription and the push-channel
 * WebSocket, exposing:
 *   - `monitor(nodeId, cb)` — refcounted live subscription to a node's value,
 *   - `read`/`write` — one-shot node attribute access,
 *   - `onConnectionChange` / `connected` — push-channel liveness.
 *
 * Notifications carry a `clientHandle` but not the NodeId, so we map
 * clientHandle → Monitor ourselves and replay each monitor's last value to new
 * subscribers and after a reconnect.
 */
export class OpcuaClient implements vscode.Disposable {
  private sessionId: number | null = null;
  private subscriptionId: number | null = null;
  private ws: WebSocket | null = null;

  private cancelled = false;
  private connecting = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;

  private handleSeq = 0;
  private readonly byNode = new Map<string, Monitor>();
  private readonly byHandle = new Map<number, Monitor>();

  private readonly _onConnect = new vscode.EventEmitter<boolean>();
  readonly onConnectionChange = this._onConnect.event;

  /** Fires when the runtime is reachable but lacks the OPC-UA facade (the
   *  session endpoint 404s) — i.e. the runtime is too old and needs updating. */
  private readonly _onUnsupported = new vscode.EventEmitter<void>();
  readonly onUnsupported = this._onUnsupported.event;

  /** Sticky: true once we've detected a too-old runtime. Lets a listener that
   *  attaches after detection still react (no activation-time race). */
  private _unsupported = false;
  get unsupported(): boolean { return this._unsupported; }

  private _connected = false;
  get connected(): boolean { return this._connected; }

  constructor(private readonly getBaseUrl: () => string = serverUrl) {
    void this.connect();
  }

  // --- public API -----------------------------------------------------------

  /** Tear down the session/socket and reconnect with backoff reset. */
  reconnect(): void {
    this.cancelled = false;
    this.teardown();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.backoffMs = INITIAL_BACKOFF_MS;
    void this.connect();
  }

  /** Refcounted live subscription to a node. The monitored item is created on
   *  the first subscriber and deleted when the last one disposes. The callback
   *  fires immediately with the last known value if one is cached. */
  monitor(nodeId: string, cb: MonitorCallback): vscode.Disposable {
    let m = this.byNode.get(nodeId);
    if (!m) {
      m = { nodeId, clientHandle: ++this.handleSeq, cbs: new Set(), hasValue: false };
      this.byNode.set(nodeId, m);
      this.byHandle.set(m.clientHandle, m);
      if (this.sessionId !== null && this.subscriptionId !== null) {
        void this.addMonitoredItem(m);
      }
    }
    m.cbs.add(cb);
    if (m.hasValue) { try { cb(m.lastValue, true); } catch { /* ignore */ } }

    return new vscode.Disposable(() => {
      const cur = this.byNode.get(nodeId);
      if (!cur) return;
      cur.cbs.delete(cb);
      if (cur.cbs.size > 0) return;
      this.byNode.delete(nodeId);
      this.byHandle.delete(cur.clientHandle);
      void this.deleteMonitoredItem(cur);
    });
  }

  /** Read a node's Value attribute. Returns the parsed value and OPC-UA status. */
  async read(nodeId: string): Promise<{ value: unknown; ok: boolean }> {
    const sid = await this.ensureSession();
    const r = await this.fetchJson<{ status?: { code?: number }; value?: unknown }>(
      `/api/1.0/opcua/sessions/${sid}/nodes/${encodeURIComponent(nodeId)}/attributes/Value`,
    );
    return { value: r.value, ok: (r.status?.code ?? 0) === 0 };
  }

  /** Write a node's Value attribute. Returns true on a Good status. */
  async write(nodeId: string, value: unknown): Promise<boolean> {
    const sid = await this.ensureSession();
    const r = await this.fetchJson<{ status?: { code?: number } }>(
      `/api/1.0/opcua/sessions/${sid}/nodes/${encodeURIComponent(nodeId)}/attributes/Value`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) },
    );
    return (r.status?.code ?? 0) === 0;
  }

  dispose(): void {
    this.cancelled = true;
    this.teardown();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._onConnect.dispose();
    this._onUnsupported.dispose();
    this.byNode.clear();
    this.byHandle.clear();
  }

  // --- connection lifecycle -------------------------------------------------

  private async connect(): Promise<void> {
    if (this.cancelled || this.connecting || this.ws) return;
    this.connecting = true;
    try {
      const sid = await this.ensureSession();
      this.openPushChannel(sid);
      // Push channel onopen finishes wiring (monitored items, connected event).
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    this.connecting = false;
  }

  /** Create the session + subscription if missing. Concurrent callers share the
   *  same in-flight creation. Returns the session id. */
  private ensureSession(): Promise<number> {
    if (this.sessionId !== null && this.subscriptionId !== null) {
      return Promise.resolve(this.sessionId);
    }
    if (!this.sessionPromise) {
      this.sessionPromise = this.createSession().finally(() => { this.sessionPromise = null; });
    }
    return this.sessionPromise;
  }
  private sessionPromise: Promise<number> | null = null;

  private async createSession(): Promise<number> {
    let s: { id: number };
    try {
      s = await this.fetchJson<{ id: number }>(
        '/api/1.0/opcua/sessions',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeout: SESSION_TIMEOUT_MS }) },
      );
    } catch (e) {
      // Distinguish "runtime too old (no OPC-UA facade)" from "runtime down".
      // A 404/405 proves the server answered but the route is missing. For any
      // other failure (e.g. a static handler returning non-JSON HTML, or a
      // dropped connection), fall back to probing plain REST: if /api/modules
      // is reachable, the runtime is up but lacks the facade → too old.
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 405 || await this.restReachable()) {
        this._unsupported = true;
        this._onUnsupported.fire();
      }
      throw e;
    }
    this.sessionId = s.id;
    const interval = vscode.workspace.getConfiguration('loom')
      .get<number>('publishingIntervalMs', DEFAULT_PUBLISHING_INTERVAL_MS);
    const sub = await this.fetchJson<{ subscriptionId: number }>(
      `/api/1.0/opcua/sessions/${s.id}/subscriptions`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publishingInterval: interval }) },
    );
    this.subscriptionId = sub.subscriptionId;
    return s.id;
  }

  private openPushChannel(sid: number): void {
    const url = `${this.wsBase()}/api/1.0/pushchannel?sessionid=${sid}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.backoffMs = INITIAL_BACKOFF_MS;
      this._unsupported = false;
      this._connected = true;
      this._onConnect.fire(true);
      // (Re)create every monitored item against the (possibly new) session.
      for (const m of this.byNode.values()) { m.monitoredItemId = undefined; void this.addMonitoredItem(m); }
      this.startKeepalive();
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.handleDrop();
    });

    ws.on('error', () => { /* swallow — 'close' follows and drives reconnect */ });

    ws.on('message', (data: RawData) => {
      if (this.ws !== ws) return;
      const text = decodeFrame(data);
      if (!text) return;
      this.dispatch(text);
    });
  }

  private dispatch(text: string): void {
    let frame: PushFrame;
    try { frame = JSON.parse(text) as PushFrame; } catch { return; }
    const notifs = frame.DataNotifications;
    if (!Array.isArray(notifs)) return;
    for (const n of notifs) {
      const m = this.byHandle.get(n.clientHandle);
      if (!m) continue;
      const ok = (n.status?.code ?? 0) === 0;
      m.lastValue = n.value;
      m.hasValue = true;
      for (const cb of m.cbs) { try { cb(n.value, ok); } catch { /* ignore */ } }
    }
  }

  /** Push-channel dropped or session lost: drop the session so the next connect
   *  rebuilds it, then schedule a reconnect. Monitors are kept and re-created. */
  private handleDrop(): void {
    const wasConnected = this._connected;
    this._connected = false;
    this.sessionId = null;
    this.subscriptionId = null;
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.removeAllListeners(); ws.close(); } catch { /* ignore */ } }
    if (wasConnected) this._onConnect.fire(false);
    this.scheduleReconnect();
  }

  private teardown(): void {
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    const ws = this.ws;
    const sid = this.sessionId;
    this.ws = null;
    this._connected = false;
    if (ws) { try { ws.removeAllListeners(); ws.close(); } catch { /* ignore */ } }
    // Best-effort session delete (fire-and-forget); ignore failures.
    if (sid !== null) { void this.fetchVoid(`/api/1.0/opcua/sessions/${sid}`, { method: 'DELETE' }).catch(() => {}); }
    this.sessionId = null;
    this.subscriptionId = null;
    // Forget server-side item ids; they belong to the deleted session.
    for (const m of this.byNode.values()) m.monitoredItemId = undefined;
  }

  private scheduleReconnect(): void {
    if (this.cancelled || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      const sid = this.sessionId;
      if (sid === null) return;
      void this.fetchVoid(`/api/1.0/opcua/sessions/${sid}`, { method: 'PATCH' })
        .catch(() => { /* session likely gone; the ws close will drive reconnect */ });
    }, KEEPALIVE_MS);
  }

  // --- monitored items ------------------------------------------------------

  private async addMonitoredItem(m: Monitor): Promise<void> {
    const sid = this.sessionId;
    const sub = this.subscriptionId;
    if (sid === null || sub === null) return;
    try {
      const r = await this.fetchJson<{ monitoredItemId?: number }>(
        `/api/1.0/opcua/sessions/${sid}/subscriptions/${sub}/monitoredItems`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            itemToMonitor: { nodeId: m.nodeId, attribute: 'Value' },
            monitoringParameters: { clientHandle: m.clientHandle, samplingInterval: 0, queueSize: 1 },
          }),
        },
      );
      // The monitor may have been disposed while the request was in flight.
      if (this.byNode.get(m.nodeId) === m) m.monitoredItemId = r.monitoredItemId;
    } catch {
      /* Session may have just dropped; reconnect re-adds every item. */
    }
  }

  private async deleteMonitoredItem(m: Monitor): Promise<void> {
    const sid = this.sessionId;
    const sub = this.subscriptionId;
    if (sid === null || sub === null || m.monitoredItemId === undefined) return;
    await this.fetchVoid(
      `/api/1.0/opcua/sessions/${sid}/subscriptions/${sub}/monitoredItems/${m.monitoredItemId}`,
      { method: 'DELETE' },
    ).catch(() => { /* best effort */ });
  }

  // --- HTTP helpers ---------------------------------------------------------

  private base(): string { return this.getBaseUrl().replace(/\/+$/, ''); }
  private wsBase(): string { return this.base().replace(/^http/i, 'ws'); }

  /** True if the runtime answers plain REST — used to tell "facade missing"
   *  (runtime too old) apart from "runtime down" when a session fails. */
  private async restReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base()}/api/modules`, { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base()}${path}`, init);
    if (!res.ok) throw httpError(res.status, res.statusText, path);
    return (await res.json()) as T;
  }

  private async fetchVoid(path: string, init?: RequestInit): Promise<void> {
    const res = await fetch(`${this.base()}${path}`, init);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  }
}

/** An Error carrying the HTTP status so callers can distinguish a 404 (old
 *  runtime, no facade) from a network failure (runtime down, no status). */
function httpError(status: number, statusText: string, path: string): Error & { status: number } {
  const err = new Error(`${status} ${statusText} — ${path}`) as Error & { status: number };
  err.status = status;
  return err;
}

function decodeFrame(data: RawData): string | null {
  try {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    return null;
  } catch {
    return null;
  }
}

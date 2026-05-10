import * as vscode from 'vscode';
import WebSocket, { type RawData } from 'ws';

import type { ModuleStats, ClassLiveStats } from './types';
import { serverUrl } from '../util/paths';

export interface LiveUpdate {
  type: 'live';
  modules: Record<string, {
    runtime?: Record<string, unknown>;
    summary?: Record<string, unknown>;
    stats?: ModuleStats;
  }>;
  classes?: Record<string, ClassLiveStats>;
}

export interface RuntimeUpdate {
  type: 'runtime';
  modules: Record<string, { runtime: Record<string, unknown> }>;
}

type WsMessage = LiveUpdate | RuntimeUpdate;

const LIVE_FLUSH_MS = 500;     // 2Hz throttle, mirrors the React app
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

export class LiveStream implements vscode.Disposable {
  private ws: WebSocket | null = null;
  private cancelled = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private liveFlushTimer: NodeJS.Timeout | null = null;
  private pendingLive: LiveUpdate | null = null;

  private readonly runtimeRefs = new Map<string, number>();

  private readonly _onConnect = new vscode.EventEmitter<boolean>();
  private readonly _onLive = new vscode.EventEmitter<LiveUpdate>();
  private readonly _onRuntime = new vscode.EventEmitter<RuntimeUpdate>();

  readonly onConnectionChange = this._onConnect.event;
  readonly onLive = this._onLive.event;
  readonly onRuntime = this._onRuntime.event;

  private _connected = false;
  get connected(): boolean { return this._connected; }

  constructor() {
    this.connect();
  }

  /** Tear down the current socket and reconnect with backoff reset. */
  reconnect(): void {
    this.cancelled = false;
    this.closeSocket();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.connect();
  }

  /** Refcounted runtime subscription. The actual unsubscribe fires only when the count drops to 0. */
  subscribeRuntime(moduleId: string): void {
    const prev = this.runtimeRefs.get(moduleId) ?? 0;
    this.runtimeRefs.set(moduleId, prev + 1);
    if (prev === 0) {
      this.send({ type: 'subscribe', topics: [`module/${moduleId}/runtime`] });
    }
  }

  unsubscribeRuntime(moduleId: string): void {
    const prev = this.runtimeRefs.get(moduleId) ?? 0;
    if (prev <= 0) return;
    if (prev === 1) {
      this.runtimeRefs.delete(moduleId);
      this.send({ type: 'unsubscribe', topics: [`module/${moduleId}/runtime`] });
    } else {
      this.runtimeRefs.set(moduleId, prev - 1);
    }
  }

  dispose(): void {
    this.cancelled = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.liveFlushTimer) { clearTimeout(this.liveFlushTimer); this.liveFlushTimer = null; }
    this.pendingLive = null;
    this.closeSocket();
    this._onConnect.dispose();
    this._onLive.dispose();
    this._onRuntime.dispose();
  }

  private send(msg: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  private closeSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    try { ws.removeAllListeners(); ws.close(); } catch { /* ignore */ }
  }

  private wsUrl(): string {
    const base = serverUrl().replace(/^http/i, 'ws').replace(/\/+$/, '');
    return `${base}/ws`;
  }

  private connect(): void {
    if (this.cancelled) return;
    let url: string;
    try { url = this.wsUrl(); }
    catch { this.scheduleReconnect(); return; }

    const ws = new WebSocket(url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.backoffMs = INITIAL_BACKOFF_MS;
      this._connected = true;
      this._onConnect.fire(true);
      // Re-send active runtime subscriptions after reconnect.
      const ids = [...this.runtimeRefs.keys()];
      if (ids.length > 0) {
        this.send({ type: 'subscribe', topics: ids.map((id) => `module/${id}/runtime`) });
      }
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const wasConnected = this._connected;
      this._connected = false;
      if (wasConnected) this._onConnect.fire(false);
      this.scheduleReconnect();
    });

    // Don't react in 'error' — close fires too and avoids racing reconnects.
    ws.on('error', () => { /* swallow */ });

    ws.on('message', (data: RawData) => {
      if (this.ws !== ws) return;
      const text = decodeFrame(data);
      if (!text) return;
      let msg: WsMessage;
      try { msg = JSON.parse(text) as WsMessage; }
      catch { return; }
      if (msg.type === 'live') {
        this.pendingLive = msg;
        this.scheduleLiveFlush();
      } else if (msg.type === 'runtime') {
        this._onRuntime.fire(msg);
      }
    });
  }

  private scheduleLiveFlush(): void {
    if (this.liveFlushTimer) return;
    this.liveFlushTimer = setTimeout(() => {
      this.liveFlushTimer = null;
      if (this.cancelled) return;
      const frame = this.pendingLive;
      this.pendingLive = null;
      if (frame) this._onLive.fire(frame);
    }, LIVE_FLUSH_MS);
  }

  private scheduleReconnect(): void {
    if (this.cancelled || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
  }
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

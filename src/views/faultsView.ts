import * as vscode from 'vscode';
import type { LoomClient } from '../api/client';
import type { OpcuaClient } from '../api/opcuaClient';
import type { FaultSummary } from '../api/types';
import { serverUrl } from '../util/paths';

type Node = StatusNode | FaultNode;

class StatusNode {
  readonly kind = 'status';
  constructor(
    public readonly httpReachable: boolean,
    public readonly count: number,
    public readonly url: string,
  ) {}
}
export class FaultNode {
  readonly kind = 'fault';
  constructor(public readonly info: FaultSummary) {}
}

/**
 * FaultsProvider — the "Faults" tree: one row per crash/fault report served by
 * GET /api/faults (this run's exceptions plus persisted prior-run crashes).
 * Mirrors ModulesProvider: REST polling with a live-connection nudge to refetch
 * on (re)connect. Clicking a fault opens the crash-report webview.
 */
export class FaultsProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private faults: FaultSummary[] = [];
  private httpReachable = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private inflight = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly client: LoomClient,
    private readonly opc: OpcuaClient,
  ) {
    this.startPolling();
    this.disposables.push(
      this.opc.onConnectionChange((connected) => {
        if (connected) void this.poll();
        else this._onDidChange.fire(undefined);
      }),
    );
  }

  refresh(): void {
    void this.poll();
  }

  private startPolling(): void {
    void this.poll();
    const intervalMs = vscode.workspace.getConfiguration('loom').get<number>('pollIntervalMs', 5000);
    this.pollTimer = setInterval(() => void this.poll(), intervalMs);
  }

  private async poll(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      this.faults = await this.client.getFaults();
      this.httpReachable = true;
    } catch {
      this.faults = [];
      this.httpReachable = false;
    } finally {
      this.inflight = false;
      this._onDidChange.fire(undefined);
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'status') {
      const item = new vscode.TreeItem(
        node.httpReachable
          ? (node.count === 0 ? `No faults — ${node.url}` : `${node.count} fault${node.count === 1 ? '' : 's'} — ${node.url}`)
          : `Disconnected — ${node.url}`,
      );
      item.iconPath = new vscode.ThemeIcon(
        node.httpReachable ? (node.count === 0 ? 'pass-filled' : 'warning') : 'circle-slash',
      );
      item.contextValue = 'faultStatus';
      item.tooltip = node.httpReachable
        ? 'Faults captured by the Loom runtime (module exceptions + crash reports).'
        : 'Cannot reach the Loom runtime. Check loom.serverUrl.';
      return item;
    }

    const f = node.info;
    const when = f.ts ? new Date(f.ts).toLocaleString() : '';
    const who = f.module || '(runtime)';
    const item = new vscode.TreeItem(`${who} · ${f.phase || '?'}`, vscode.TreeItemCollapsibleState.None);
    item.description = `${f.kind}${f.reason ? ' · ' + f.reason : ''}${when ? ' · ' + when : ''}`;
    item.tooltip = [
      `id: ${f.id}`,
      `kind: ${f.kind}`,
      `module: ${who}${f.class ? ' (' + f.class + ')' : ''}`,
      `phase: ${f.phase}`,
      f.reason ? `reason: ${f.reason}` : '',
      when ? `time: ${when}` : '',
    ].filter(Boolean).join('\n');
    item.contextValue = 'fault';
    item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
    item.command = {
      command: 'loom.faults.openReport',
      title: 'Open Crash Report',
      arguments: [f.id],
    };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const status = new StatusNode(this.httpReachable, this.faults.length, serverUrl());
      return [status, ...this.faults.map((f) => new FaultNode(f))];
    }
    return [];
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const d of this.disposables) d.dispose();
    this._onDidChange.dispose();
  }
}

import * as vscode from 'vscode';
import * as path from 'path';
import type { FaultSummary } from '../api/types';
import { type FaultSource, DiskFaultSource, RestFaultSource } from '../api/faultSource';
import { resolvePaths } from '../util/paths';

type Node = SourceNode | FaultNode;

class SourceNode {
  readonly kind = 'source';
  constructor(
    public readonly source: FaultSource,
    public readonly faults: FaultSummary[],
    public readonly available: boolean,
  ) {}
}
export class FaultNode {
  readonly kind = 'fault';
  constructor(public readonly source: FaultSource, public readonly info: FaultSummary) {}
}

interface SourceState { faults: FaultSummary[]; available: boolean }

/**
 * FaultsProvider — the "Faults" tree, grouped by source. Disk is the model: the
 * local data dir's crash folder is always present (auto-detected, works with the
 * runtime offline), and the user can add folders, open files, or attach a running
 * runtime. Each source is a top-level group; its crash reports are the children.
 */
export class FaultsProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  /** Sources the user explicitly added (folders / runtimes). The local data dir
   *  source is synthesized fresh each poll so it tracks loom.dataDir changes. */
  private readonly userSources: FaultSource[] = [];
  private readonly cache = new Map<string, SourceState>();
  private pollTimer: NodeJS.Timeout | null = null;
  private inflight = false;

  constructor() {
    this.startPolling();
  }

  refresh(): void { void this.poll(); }

  /** The always-present local data dir crash folder, recomputed each poll. */
  private defaultSource(): FaultSource {
    const { dataDir } = resolvePaths();
    return new DiskFaultSource(path.join(dataDir, 'crash'), 'Local data dir', false);
  }

  private sources(): FaultSource[] {
    return [this.defaultSource(), ...this.userSources];
  }

  addFolder(dir: string): void {
    const src = new DiskFaultSource(dir, path.basename(dir) || dir, true);
    if (this.userSources.some((s) => s.id === src.id) || src.id === this.defaultSource().id) {
      void this.poll();
      return;
    }
    this.userSources.push(src);
    void this.poll();
  }

  addRuntime(url: string, label?: string): void {
    const src = new RestFaultSource(url, label ?? `Runtime (${url})`);
    if (!this.userSources.some((s) => s.id === src.id)) this.userSources.push(src);
    void this.poll();
  }

  removeSource(id: string): void {
    const i = this.userSources.findIndex((s) => s.id === id);
    if (i >= 0) { this.userSources.splice(i, 1); this.cache.delete(id); void this.poll(); }
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
      const srcs = this.sources();
      const seen = new Set<string>();
      await Promise.all(srcs.map(async (s) => {
        seen.add(s.id);
        const [faults, available] = await Promise.all([
          s.list().catch(() => [] as FaultSummary[]),
          s.available().catch(() => false),
        ]);
        this.cache.set(s.id, { faults, available });
      }));
      for (const key of [...this.cache.keys()]) if (!seen.has(key)) this.cache.delete(key);
    } finally {
      this.inflight = false;
      this._onDidChange.fire(undefined);
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'source') {
      const s = node.source;
      const item = new vscode.TreeItem(s.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = node.available
        ? `${node.faults.length} · ${s.detailText}`
        : `unavailable · ${s.detailText}`;
      item.tooltip = `${s.label}\n${s.detailText}\n${node.available ? `${node.faults.length} report(s)` : 'not reachable / missing'}`;
      item.iconPath = new vscode.ThemeIcon(node.available ? s.icon : 'circle-slash');
      item.contextValue = s.removable ? 'faultSourceRemovable' : 'faultSource';
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
    item.command = { command: 'loom.faults.openReport', title: 'Open Crash Report', arguments: [node] };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.sources().map((s) => {
        const st = this.cache.get(s.id) ?? { faults: [], available: false };
        return new SourceNode(s, st.faults, st.available);
      });
    }
    if (node.kind === 'source') {
      return node.faults.map((f) => new FaultNode(node.source, f));
    }
    return [];
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this._onDidChange.dispose();
  }
}

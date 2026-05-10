import * as vscode from 'vscode';
import type { LoomClient } from '../api/client';
import type { LiveStream } from '../api/liveStream';
import type { ClassInfo, ClassLiveStats } from '../api/types';

type Node = ClassNode | MemberNode;

class ClassNode {
  readonly kind = 'class';
  constructor(public readonly info: ClassInfo, public readonly live: ClassLiveStats | undefined) {}
}
class MemberNode {
  readonly kind = 'member';
  constructor(public readonly id: string) {}
}

export class SchedulerProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private classes: ClassInfo[] = [];
  private liveStats: Record<string, ClassLiveStats> = {};
  private pollTimer: NodeJS.Timeout | null = null;

  private readonly _onChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onChange.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly client: LoomClient,
    private readonly live: LiveStream,
  ) {
    void this.poll();
    const intervalMs = vscode.workspace.getConfiguration('loom').get<number>('pollIntervalMs', 5000);
    this.pollTimer = setInterval(() => void this.poll(), Math.max(intervalMs * 2, 5000));

    this.disposables.push(
      this.live.onLive((u) => {
        if (!u.classes) return;
        this.liveStats = u.classes;
        this._onChange.fire(undefined);
      }),
      this.live.onConnectionChange((connected) => {
        if (connected) void this.poll();
        else this._onChange.fire(undefined);
      }),
    );
  }

  refresh(): void { void this.poll(); }

  private async poll(): Promise<void> {
    try {
      this.classes = await this.client.getSchedulerClasses();
    } catch {
      this.classes = [];
    }
    this._onChange.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'class') {
      const c = node.info;
      const live = node.live;
      const expandable = (c.modules?.length ?? 0) > 0;
      const item = new vscode.TreeItem(
        c.name,
        expandable ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      );
      const periodMs = c.period_us / 1000;
      const cycle = live ? `${live.lastCycleTimeUs}µs` : '–';
      const ticks = live ? live.tickCount.toLocaleString() : '–';
      item.description = `${periodMs.toFixed(1)}ms · prio ${c.priority} · ${cycle} · ticks ${ticks}`;
      item.tooltip = [
        `class: ${c.name}`,
        `period: ${c.period_us}µs (${periodMs.toFixed(2)}ms)`,
        `priority: ${c.priority}`,
        `cpu_affinity: ${c.cpu_affinity}`,
        `spin: ${c.spin_us}µs`,
        live
          ? `last cycle: ${live.lastCycleTimeUs}µs (max ${live.maxCycleTimeUs}µs, jitter ${live.lastJitterUs}µs)`
          : 'no live stats',
      ].join('\n');
      item.iconPath = new vscode.ThemeIcon('clock');
      item.contextValue = 'schedulerClass';
      return item;
    } else {
      const item = new vscode.TreeItem(node.id);
      item.iconPath = new vscode.ThemeIcon('chip');
      item.contextValue = 'schedulerMember';
      item.command = {
        command: 'loom.modules.openDetail',
        title: 'Open Module',
        arguments: [node.id],
      };
      return item;
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.classes
        .slice()
        .sort((a, b) => a.period_us - b.period_us || a.name.localeCompare(b.name))
        .map((c) => new ClassNode(c, this.liveStats[c.name]));
    }
    if (node.kind === 'class') {
      return (node.info.modules ?? []).map((id) => new MemberNode(id));
    }
    return [];
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const d of this.disposables) d.dispose();
    this._onChange.dispose();
  }
}

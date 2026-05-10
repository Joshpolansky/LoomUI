import * as vscode from 'vscode';
import type { LoomClient } from '../api/client';
import type { LiveStream } from '../api/liveStream';
import type { ClassInfo, ClassLiveStats } from '../api/types';

export type Node = ClassNode | MemberNode;

const DRAG_MIME = 'application/vnd.code.tree.loom.scheduler';

export class ClassNode {
  readonly kind = 'class';
  constructor(public readonly info: ClassInfo, public readonly live: ClassLiveStats | undefined) {}
}
export class MemberNode {
  readonly kind = 'member';
  constructor(public readonly id: string, public readonly className: string) {}
}

export class SchedulerProvider
  implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>, vscode.Disposable
{
  // TreeDragAndDropController contract
  readonly dragMimeTypes = [DRAG_MIME];
  readonly dropMimeTypes = [DRAG_MIME];

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

  classNames(): string[] {
    return this.classes.map((c) => c.name);
  }

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
      return (node.info.modules ?? []).map((id) => new MemberNode(id, node.info.name));
    }
    return [];
  }

  // ---------- drag & drop ----------

  handleDrag(source: readonly Node[], dataTransfer: vscode.DataTransfer): void {
    const members = source.filter((n): n is MemberNode => n.kind === 'member');
    if (members.length === 0) return;
    // Encode as JSON array of { id, fromClass } so handleDrop knows the
    // source class (useful for "no-op when dropped on the same class").
    dataTransfer.set(
      DRAG_MIME,
      new vscode.DataTransferItem(JSON.stringify(
        members.map((m) => ({ id: m.id, fromClass: m.className })),
      )),
    );
  }

  async handleDrop(target: Node | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    if (!target) return;
    const targetClassName = target.kind === 'class' ? target.info.name : target.className;
    if (!targetClassName) return;

    const item = dataTransfer.get(DRAG_MIME);
    if (!item) return;
    let payload: Array<{ id: string; fromClass: string }>;
    try {
      payload = JSON.parse(typeof item.value === 'string' ? item.value : await item.asString());
    } catch {
      return;
    }
    const reassigns = payload.filter((p) => p.fromClass !== targetClassName);
    if (reassigns.length === 0) return;

    const failures: string[] = [];
    for (const { id } of reassigns) {
      try {
        await this.client.reassignModuleClass(id, targetClassName);
      } catch (e) {
        failures.push(`${id}: ${(e as Error).message}`);
      }
    }
    if (failures.length > 0) {
      vscode.window.showErrorMessage(`Reassign failed: ${failures.join('; ')}`);
    }
    this.refresh();
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const d of this.disposables) d.dispose();
    this._onChange.dispose();
  }
}

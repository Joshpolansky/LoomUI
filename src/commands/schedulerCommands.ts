import * as vscode from 'vscode';
import type { LoomClient } from '../api/client';
import type { ClassInfo } from '../api/types';
import { ClassNode, MemberNode, type SchedulerProvider } from '../views/schedulerView';

type EditableField = 'period_us' | 'priority' | 'cpu_affinity' | 'spin_us';

const FIELD_LABEL: Record<EditableField, string> = {
  period_us:    'Period (µs)',
  priority:     'Priority',
  cpu_affinity: 'CPU affinity',
  spin_us:      'Spin (µs)',
};

const FIELD_HINT: Record<EditableField, string> = {
  period_us:    'positive integer in microseconds (e.g. 1000 = 1ms)',
  priority:     'integer; higher = preempts lower',
  cpu_affinity: '-1 for any core, otherwise the CPU index',
  spin_us:      'positive integer in microseconds; busy-spin window before the next tick',
};

export function registerSchedulerCommands(
  context: vscode.ExtensionContext,
  client: LoomClient,
  provider: SchedulerProvider,
): void {
  async function pickClass(prompt: string): Promise<ClassInfo | undefined> {
    let classes: ClassInfo[];
    try {
      classes = await client.getSchedulerClasses();
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot reach Loom: ${(e as Error).message}`);
      return undefined;
    }
    if (classes.length === 0) {
      vscode.window.showInformationMessage('No scheduler classes defined.');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      classes.map((c) => ({
        label: c.name,
        description: `${(c.period_us / 1000).toFixed(1)}ms · prio ${c.priority}`,
        cls: c,
      })),
      { placeHolder: prompt },
    );
    return pick?.cls;
  }

  async function resolveClass(arg: unknown, prompt: string): Promise<ClassInfo | undefined> {
    if (arg instanceof ClassNode) return arg.info;
    return pickClass(prompt);
  }

  async function editField(cls: ClassInfo, field: EditableField): Promise<void> {
    const current = cls[field];
    const next = await vscode.window.showInputBox({
      prompt: `${FIELD_LABEL[field]} for class '${cls.name}'`,
      value: String(current),
      placeHolder: FIELD_HINT[field],
      validateInput: (v) => {
        const t = v.trim();
        if (!/^-?\d+$/.test(t)) return 'must be an integer';
        const n = parseInt(t, 10);
        if (field === 'period_us' && n <= 0) return 'period must be > 0';
        if (field === 'spin_us'   && n < 0)  return 'spin must be ≥ 0';
        return null;
      },
    });
    if (next === undefined) return;
    const value = parseInt(next.trim(), 10);
    if (value === current) return;
    try {
      await client.updateSchedulerClass(cls.name, { [field]: value });
      provider.refresh();
    } catch (e) {
      vscode.window.showErrorMessage(`Update ${FIELD_LABEL[field]} failed: ${(e as Error).message}`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('loom.scheduler.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('loom.scheduler.editPeriod', async (node?: unknown) => {
      const cls = await resolveClass(node, 'Edit period of class');
      if (cls) await editField(cls, 'period_us');
    }),
    vscode.commands.registerCommand('loom.scheduler.editPriority', async (node?: unknown) => {
      const cls = await resolveClass(node, 'Edit priority of class');
      if (cls) await editField(cls, 'priority');
    }),
    vscode.commands.registerCommand('loom.scheduler.editCpuAffinity', async (node?: unknown) => {
      const cls = await resolveClass(node, 'Edit CPU affinity of class');
      if (cls) await editField(cls, 'cpu_affinity');
    }),
    vscode.commands.registerCommand('loom.scheduler.editSpin', async (node?: unknown) => {
      const cls = await resolveClass(node, 'Edit spin of class');
      if (cls) await editField(cls, 'spin_us');
    }),

    vscode.commands.registerCommand('loom.scheduler.newClass', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'New scheduler class name',
        placeHolder: 'e.g. fast_1ms',
        validateInput: (v) => v.trim().length === 0 ? 'name is required' : null,
      });
      if (!name) return;

      const periodStr = await vscode.window.showInputBox({
        prompt: `Period for '${name}' (µs)`,
        placeHolder: '1000 = 1ms',
        validateInput: (v) => /^\d+$/.test(v.trim()) && parseInt(v, 10) > 0 ? null : 'positive integer required',
      });
      if (!periodStr) return;

      const priorityStr = await vscode.window.showInputBox({
        prompt: `Priority for '${name}'`,
        value: '50',
        validateInput: (v) => /^-?\d+$/.test(v.trim()) ? null : 'integer required',
      });
      if (priorityStr === undefined) return;

      const affinityStr = await vscode.window.showInputBox({
        prompt: `CPU affinity for '${name}'`,
        value: '-1',
        placeHolder: '-1 = any core',
        validateInput: (v) => /^-?\d+$/.test(v.trim()) ? null : 'integer required',
      });
      if (affinityStr === undefined) return;

      const spinStr = await vscode.window.showInputBox({
        prompt: `Spin window for '${name}' (µs)`,
        value: '0',
        validateInput: (v) => /^\d+$/.test(v.trim()) ? null : 'non-negative integer required',
      });
      if (spinStr === undefined) return;

      try {
        await client.createSchedulerClass({
          name: name.trim(),
          period_us:    parseInt(periodStr,   10),
          priority:     parseInt(priorityStr, 10),
          cpu_affinity: parseInt(affinityStr, 10),
          spin_us:      parseInt(spinStr,     10),
        });
        provider.refresh();
        vscode.window.showInformationMessage(`Created scheduler class '${name.trim()}'.`);
      } catch (e) {
        vscode.window.showErrorMessage(`Create class failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('loom.scheduler.reassign', async (node?: unknown) => {
      let moduleId: string | undefined;
      let currentClass: string | undefined;
      if (node instanceof MemberNode) {
        moduleId = node.id;
        currentClass = node.className;
      } else {
        const id = await vscode.window.showInputBox({
          prompt: 'Module ID to reassign',
          validateInput: (v) => v.trim().length > 0 ? null : 'ID required',
        });
        if (!id) return;
        moduleId = id.trim();
      }

      let classes: ClassInfo[];
      try {
        classes = await client.getSchedulerClasses();
      } catch (e) {
        vscode.window.showErrorMessage(`Cannot reach Loom: ${(e as Error).message}`);
        return;
      }
      if (classes.length === 0) {
        vscode.window.showInformationMessage('No scheduler classes defined.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        classes
          .filter((c) => c.name !== currentClass)
          .map((c) => ({
            label: c.name,
            description: `${(c.period_us / 1000).toFixed(1)}ms · prio ${c.priority}`,
            cls: c,
          })),
        { placeHolder: `Move ${moduleId} to class…` },
      );
      if (!pick) return;
      try {
        await client.reassignModuleClass(moduleId, pick.cls.name);
        provider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Reassign failed: ${(e as Error).message}`);
      }
    }),
  );
}

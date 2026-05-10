import * as vscode from 'vscode';
import type { LoomClient } from '../api/client';
import type { DataSection } from '../api/types';
import { MappingNode, type MappingsProvider } from '../views/mappingsView';

export function registerMappingCommands(
  context: vscode.ExtensionContext,
  client: LoomClient,
  provider: MappingsProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('loom.mappings.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('loom.mappings.resolve', async () => {
      try {
        await client.resolveMappings();
        provider.refresh();
        vscode.window.showInformationMessage('Mappings resolved.');
      } catch (e) {
        vscode.window.showErrorMessage(`Resolve failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('loom.mappings.toggle', async (node?: unknown) => {
      if (!(node instanceof MappingNode)) return;
      const m = node.mapping;
      try {
        await client.updateMapping(node.index, {
          source: m.source,
          target: m.target,
          enabled: !m.enabled,
        });
        provider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Toggle failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('loom.mappings.delete', async (node?: unknown) => {
      if (!(node instanceof MappingNode)) return;
      const confirm = await vscode.window.showWarningMessage(
        `Delete mapping?\n${node.mapping.source} → ${node.mapping.target}`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;
      try {
        await client.deleteMapping(node.index);
        provider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Delete failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('loom.mappings.add', async () => {
      const source = await pickFieldPath(client, 'Source');
      if (!source) return;
      const target = await pickFieldPath(client, 'Target');
      if (!target) return;
      if (source === target) {
        vscode.window.showWarningMessage('Source and target must differ.');
        return;
      }
      try {
        await client.createMapping({ source, target, enabled: true });
        provider.refresh();
        vscode.window.showInformationMessage(`Mapping created: ${source} → ${target}`);
      } catch (e) {
        vscode.window.showErrorMessage(`Add failed: ${(e as Error).message}`);
      }
    }),
  );
}

// ---------- picker ----------

async function pickFieldPath(client: LoomClient, role: string): Promise<string | undefined> {
  // 1. Module
  let modules;
  try {
    modules = await client.getModules();
  } catch (e) {
    vscode.window.showErrorMessage(`Cannot reach Loom: ${(e as Error).message}`);
    return undefined;
  }
  if (modules.length === 0) {
    vscode.window.showInformationMessage('No modules loaded.');
    return undefined;
  }
  const modulePick = await vscode.window.showQuickPick(
    modules
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({ label: m.id, description: `${m.className} v${m.version}`, id: m.id })),
    { placeHolder: `${role}: pick a module` },
  );
  if (!modulePick) return undefined;

  // 2. Section
  const sectionPick = await vscode.window.showQuickPick(
    [
      { label: 'runtime', description: 'live process variables', section: 'runtime' as DataSection },
      { label: 'config',  description: 'persisted parameters',     section: 'config'  as DataSection },
      { label: 'recipe',  description: 'product/batch parameters', section: 'recipe'  as DataSection },
    ],
    { placeHolder: `${role}: ${modulePick.id} — pick a section` },
  );
  if (!sectionPick) return undefined;

  // 3. Field path (flat list of leaf paths from the section JSON)
  let data: Record<string, unknown>;
  try {
    data = await client.getModuleData(modulePick.id, sectionPick.section);
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to fetch ${modulePick.id}.${sectionPick.section}: ${(e as Error).message}`);
    return undefined;
  }
  const paths = flattenPaths(data);
  if (paths.length === 0) {
    vscode.window.showInformationMessage(`No fields in ${modulePick.id}.${sectionPick.section}.`);
    return undefined;
  }
  const fieldPick = await vscode.window.showQuickPick(
    paths.map((p) => ({
      label: p,
      description: formatPreview(getAtPath(data, p.split('/'))),
    })),
    {
      placeHolder: `${role}: ${modulePick.id}.${sectionPick.section} — pick a field`,
      matchOnDescription: true,
    },
  );
  if (!fieldPick) return undefined;

  return `${modulePick.id}.${sectionPick.section}.${fieldPick.label}`;
}

function flattenPaths(data: unknown, prefix: string[] = []): string[] {
  if (data === null || typeof data !== 'object') {
    return prefix.length === 0 ? [] : [prefix.join('/')];
  }
  if (Array.isArray(data)) {
    return data.flatMap((v, i) => flattenPaths(v, [...prefix, String(i)]));
  }
  return Object.entries(data as Record<string, unknown>)
    .flatMap(([k, v]) => flattenPaths(v, [...prefix, k]));
}

function getAtPath(data: unknown, path: string[]): unknown {
  let cur: unknown = data;
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function formatPreview(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

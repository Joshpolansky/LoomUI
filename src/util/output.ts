import * as vscode from 'vscode';

let runtimeChannel: vscode.OutputChannel | undefined;
let extensionChannel: vscode.OutputChannel | undefined;

export function getRuntimeOutput(): vscode.OutputChannel {
  if (!runtimeChannel) runtimeChannel = vscode.window.createOutputChannel('Loom Runtime');
  return runtimeChannel;
}

export function getExtensionOutput(): vscode.OutputChannel {
  if (!extensionChannel) extensionChannel = vscode.window.createOutputChannel('Loom');
  return extensionChannel;
}

export function disposeOutputs(): void {
  runtimeChannel?.dispose();
  extensionChannel?.dispose();
  runtimeChannel = undefined;
  extensionChannel = undefined;
}

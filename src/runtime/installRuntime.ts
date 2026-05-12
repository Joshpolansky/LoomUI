import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { getExtensionOutput } from '../util/output';

const exec = promisify(execCb);

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  assets: GitHubAsset[];
  html_url: string;
}

type RuntimeFlavor = 'debug' | 'release';

interface InstalledFlavor {
  flavor: RuntimeFlavor;
  binary: string;
  modules?: string;
}

/** Fetch the latest Loom release from GitHub, download the asset matching
 *  the user's platform/arch, extract it under the extension's globalStorage
 *  directory, and update the loom.runtimeExecutable / loom.moduleDir
 *  settings to point at the extracted binary. */
export async function installLoomRuntime(context: vscode.ExtensionContext): Promise<void> {
  const out = getExtensionOutput();
  const cfg = vscode.workspace.getConfiguration('loom');
  const repo = cfg.get<string>('releaseRepo', '').trim();
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    vscode.window.showErrorMessage(
      `Set 'loom.releaseRepo' to the GitHub repo (form: owner/Loom). Current value: '${repo || '(empty)'}'`,
    );
    return;
  }

  out.show(true);
  out.appendLine(`▶ Installing Loom from github.com/${repo}`);

  // 1. Fetch latest release.
  let release: GitHubRelease;
  try {
    release = await fetchJson<GitHubRelease>(`https://api.github.com/repos/${repo}/releases/latest`);
  } catch (e) {
    vscode.window.showErrorMessage(
      `Cannot fetch latest release from ${repo}: ${(e as Error).message}. ` +
      `Visit https://github.com/${repo}/releases to download manually.`,
    );
    return;
  }

  out.appendLine(`  found release ${release.tag_name} with ${release.assets.length} asset(s)`);

  // 2. Pick assets for our platform (both debug and release when available).
  const releaseTemplate = cfg.get<string>('releaseAssetTemplateRelease', cfg.get<string>('releaseAssetTemplate', 'loom-{platform}-{arch}.tar.gz'));
  const debugTemplate = cfg.get<string>('releaseAssetTemplateDebug', 'loom-{platform}-{arch}-debug.tar.gz');
  const platform = process.platform; // darwin | linux | win32
  const arch = process.arch;          // arm64 | x64 | ...
  const templates: Record<RuntimeFlavor, string> = {
    release: releaseTemplate,
    debug: debugTemplate,
  };

  // 3. Prepare target directory under the extension's globalStorageUri.
  const installRoot = vscode.Uri.joinPath(context.globalStorageUri, 'runtimes').fsPath;
  const versionDir = path.join(installRoot, release.tag_name);
  await fs.mkdir(versionDir, { recursive: true });

  const installed: InstalledFlavor[] = [];
  // On Windows both Debug and Release runtimes are needed (CRT ABI split).
  // On other platforms a single release binary is sufficient.
  const flavors: RuntimeFlavor[] = process.platform === 'win32' ? ['release', 'debug'] : ['release'];
  for (const flavor of flavors) {
    const assetName = templates[flavor]
      .replace('{platform}', platform)
      .replace('{arch}', arch)
      .replace('{build}', flavor);
    const asset = release.assets.find((a) => a.name === assetName);
    if (!asset) {
      out.appendLine(`  warning: ${flavor} asset '${assetName}' not found in release ${release.tag_name}`);
      continue;
    }

    out.appendLine(`  ${flavor} asset: ${asset.name} (${formatBytes(asset.size)})`);
    const flavorDir = path.join(versionDir, flavor);
    await fs.mkdir(flavorDir, { recursive: true });
    const archivePath = path.join(flavorDir, asset.name);

    try {
      await downloadWithProgress(asset.browser_download_url, archivePath, asset.size, asset.name);
      out.appendLine(`  downloaded ${flavor} -> ${archivePath}`);
      await extractArchive(archivePath, flavorDir);
      out.appendLine(`  extracted ${flavor} into ${flavorDir}`);
    } catch (e) {
      out.appendLine(`  warning: failed to install ${flavor}: ${(e as Error).message}`);
      continue;
    } finally {
      try { await fs.unlink(archivePath); } catch { /* ignore */ }
    }

    const binary = await findBinary(flavorDir);
    if (!binary) {
      out.appendLine(`  warning: ${flavor} install does not contain loom binary`);
      continue;
    }
    const modules = await findModulesDir(flavorDir);
    out.appendLine(`  ${flavor} binary  : ${binary}`);
    if (modules) out.appendLine(`  ${flavor} modules : ${modules}`);

    if (process.platform !== 'win32') {
      try { await fs.chmod(binary, 0o755); } catch { /* ignore */ }
    }

    try {
      const { stdout } = await exec(`"${binary}" --version`, { timeout: 5000 });
      out.appendLine(`  ${flavor}: ${binary} --version -> ${stdout.trim()}`);
    } catch (e) {
      out.appendLine(`  warning: ${flavor} \`${binary} --version\` did not return cleanly: ${(e as Error).message}`);
    }

    installed.push({ flavor, binary, modules: modules ?? undefined });
  }

  if (installed.length === 0) {
    const available = release.assets.map((a) => a.name).join(', ') || '(none)';
    vscode.window.showErrorMessage(
      `No matching runtime assets were installed for ${platform}/${arch}. Available: ${available}. ` +
      `Check loom.releaseAssetTemplateRelease / loom.releaseAssetTemplateDebug.`,
    );
    return;
  }

  // 9. Update settings (Global so they persist across workspaces).
  const target = vscode.ConfigurationTarget.Global;
  if (process.platform === 'win32') {
    // On Windows, track per-flavor executables and module dirs so the
    // profile selector can load the right binary and module directory.
    for (const item of installed) {
      const suffix = item.flavor === 'debug' ? 'Debug' : 'Release';
      await cfg.update(`runtimeExecutable${suffix}`, item.binary, target);
      if (item.modules) await cfg.update(`systemModuleDir${suffix}`, item.modules, target);
    }
  }
  // Generic settings — used on non-Windows and as back-compat fallback.
  const releaseItem = installed.find((i) => i.flavor === 'release') ?? installed[0];
  await cfg.update('runtimeExecutable', releaseItem.binary, target);
  if (releaseItem.modules) await cfg.update('systemModuleDir', releaseItem.modules, target);
  // Clear any legacy loom.moduleDir override so the new userModuleDir /
  // systemModuleDir split is the single source of truth going forward.
  // (No-op if the user never set it.)
  if (cfg.inspect<string>('moduleDir')?.globalValue) {
    await cfg.update('moduleDir', undefined, target);
  }
  // Make sure ~/.loom/data exists as a fallback for when the user starts
  // the runtime outside any workspace. We don't pin loom.dataDir to it —
  // the workspace-relative default ${workspaceFolder}/data is preferred
  // when a project is open.
  const fallbackDataDir = path.join(os.homedir(), '.loom', 'data');
  await fs.mkdir(fallbackDataDir, { recursive: true });

  // 10. Register the install with CMake's user package registry so module
  //     projects can `find_package(loom CONFIG REQUIRED)` without any
  //     CMAKE_PREFIX_PATH or env-var setup.
  //
  //     Compute the install prefix from where the binary actually lives:
  //       <install>/loom              -> prefix = dirname(binary)
  //       <install>/bin/loom          -> prefix = dirname(dirname(binary))
  const binaryForCmake = installed.find((i) => i.flavor === 'release')?.binary ?? installed[0].binary;
  const binParent = path.dirname(binaryForCmake);
  const cmakePrefix = path.basename(binParent) === 'bin' ? path.dirname(binParent) : binParent;
  const configDir = path.join(cmakePrefix, 'lib', 'cmake', 'loom');
  if (fsSync.existsSync(configDir)) {
    try {
      const where = await registerCmakePackage(configDir);
      out.appendLine(`  registered with CMake at ${where}`);
    } catch (e) {
      out.appendLine(`  warning: failed to register with CMake user package registry: ${(e as Error).message}`);
    }
  } else {
    out.appendLine(`  skipped CMake user package registry: no lib/cmake/loom in this release`);
    out.appendLine(`    (cut a Loom release with the SDK bundling workflow to enable find_package(loom))`);
  }

  const gotDebug = installed.some((i) => i.flavor === 'debug');
  const gotRelease = installed.some((i) => i.flavor === 'release');
  const flavorSummary = process.platform === 'win32'
    ? `(${gotDebug ? 'debug' : ''}${gotDebug && gotRelease ? ' + ' : ''}${gotRelease ? 'release' : ''})`
    : '(release)';
  out.appendLine(`✓ Installed Loom ${release.tag_name} ${flavorSummary}.`);
  const profileHint = process.platform === 'win32'
    ? ` Use "Loom: Select Runtime Profile" to switch Debug/Release.`
    : '';
  vscode.window.showInformationMessage(
    `Installed Loom ${release.tag_name}.${profileHint}`,
  );
}

/** Uninstall Loom runtimes managed by this extension.
 *
 *  Deletes <globalStorage>/runtimes, clears global loom.runtimeExecutable /
 *  loom.systemModuleDir when they point into that managed install root, and
 *  removes the CMake user package registry entry created by install.
 */
export async function uninstallLoomRuntime(context: vscode.ExtensionContext): Promise<void> {
  const out = getExtensionOutput();
  const cfg = vscode.workspace.getConfiguration('loom');
  const installRoot = vscode.Uri.joinPath(context.globalStorageUri, 'runtimes').fsPath;

  const confirm = await vscode.window.showWarningMessage(
    `Uninstall Loom runtime? This removes managed installs under ${installRoot}.`,
    { modal: true },
    'Uninstall',
  );
  if (confirm !== 'Uninstall') return;

  out.show(true);
  out.appendLine(`▶ Uninstalling Loom runtime from ${installRoot}`);

  try {
    await fs.rm(installRoot, { recursive: true, force: true });
    out.appendLine('  removed managed runtime directory');
  } catch (e) {
    out.appendLine(`  warning: failed to remove managed runtime directory: ${(e as Error).message}`);
  }

  const target = vscode.ConfigurationTarget.Global;
  const runtimeExec = cfg.get<string>('runtimeExecutable', '');
  const runtimeExecDebug = cfg.get<string>('runtimeExecutableDebug', '');
  const runtimeExecRelease = cfg.get<string>('runtimeExecutableRelease', '');
  const systemModules = cfg.get<string>('systemModuleDir', '');
  const systemModulesDebug = cfg.get<string>('systemModuleDirDebug', '');
  const systemModulesRelease = cfg.get<string>('systemModuleDirRelease', '');

  const normalizedRoot = path.resolve(installRoot) + path.sep;
  const normalizeMaybe = (p: string): string => {
    if (!p) return '';
    return path.resolve(p);
  };

  const runtimeResolved = normalizeMaybe(runtimeExec);
  if (runtimeResolved && (runtimeResolved + path.sep).startsWith(normalizedRoot)) {
    await cfg.update('runtimeExecutable', undefined, target);
    out.appendLine('  cleared loom.runtimeExecutable (was extension-managed)');
  }
  if (process.platform === 'win32') {
    const runtimeResolvedDebug = normalizeMaybe(runtimeExecDebug);
    if (runtimeResolvedDebug && (runtimeResolvedDebug + path.sep).startsWith(normalizedRoot)) {
      await cfg.update('runtimeExecutableDebug', undefined, target);
      out.appendLine('  cleared loom.runtimeExecutableDebug (was extension-managed)');
    }
    const runtimeResolvedRelease = normalizeMaybe(runtimeExecRelease);
    if (runtimeResolvedRelease && (runtimeResolvedRelease + path.sep).startsWith(normalizedRoot)) {
      await cfg.update('runtimeExecutableRelease', undefined, target);
      out.appendLine('  cleared loom.runtimeExecutableRelease (was extension-managed)');
    }
  }

  const modulesResolved = normalizeMaybe(systemModules);
  if (modulesResolved && (modulesResolved + path.sep).startsWith(normalizedRoot)) {
    await cfg.update('systemModuleDir', undefined, target);
    out.appendLine('  cleared loom.systemModuleDir (was extension-managed)');
  }
  if (process.platform === 'win32') {
    const modulesResolvedDebug = normalizeMaybe(systemModulesDebug);
    if (modulesResolvedDebug && (modulesResolvedDebug + path.sep).startsWith(normalizedRoot)) {
      await cfg.update('systemModuleDirDebug', undefined, target);
      out.appendLine('  cleared loom.systemModuleDirDebug (was extension-managed)');
    }
    const modulesResolvedRelease = normalizeMaybe(systemModulesRelease);
    if (modulesResolvedRelease && (modulesResolvedRelease + path.sep).startsWith(normalizedRoot)) {
      await cfg.update('systemModuleDirRelease', undefined, target);
      out.appendLine('  cleared loom.systemModuleDirRelease (was extension-managed)');
    }
  }

  try {
    const where = await unregisterCmakePackage();
    out.appendLine(`  removed CMake package registry entries at ${where}`);
  } catch (e) {
    out.appendLine(`  warning: failed to clean CMake package registry entries: ${(e as Error).message}`);
  }

  out.appendLine('✓ Loom runtime uninstall complete.');
  vscode.window.showInformationMessage('Uninstalled Loom runtime managed by LoomUI.');
}

/** Write a CMake user package registry entry pointing at this install's
 *  loomConfig.cmake. After this, any CMake project on this user's
 *  machine that does `find_package(loom CONFIG REQUIRED)` will find the
 *  SDK shipped in the binary release — no CMAKE_PREFIX_PATH, no env vars.
 *
 *  POSIX: writes `~/.cmake/packages/loom/loom-workbench` containing the
 *  absolute path to configDir.
 *  Windows: writes HKCU\Software\Kitware\CMake\Packages\loom\loom-workbench
 *  via reg.exe with the same path as the value's data.
 *
 *  Also removes any legacy `loomui` entry from a previous version of this
 *  extension so the registry stays clean across the rename.
 *
 *  Returns the location of the new registry entry. */
async function registerCmakePackage(configDir: string): Promise<string> {
  if (process.platform === 'win32') {
    // CMake reads HKEY_CURRENT_USER\Software\Kitware\CMake\Packages\<name>.
    // Each value's data is an absolute path to a dir containing
    // <name>Config.cmake. Value name can be anything; we use
    // "loom-workbench" so reinstalls overwrite the same entry instead of
    // accumulating.
    const key = 'HKCU\\Software\\Kitware\\CMake\\Packages\\loom';
    // Best-effort cleanup of the legacy "loomui" value (predecessor name).
    try { await exec(`reg delete "${key}" /v "loomui" /f`); } catch { /* ignore: didn't exist */ }
    await exec(`reg add "${key}" /v "loom-workbench" /t REG_SZ /d "${configDir}" /f`);
    return `${key}\\loom-workbench`;
  }

  // POSIX: each file under ~/.cmake/packages/<name>/ contains a path that
  // CMake adds to its search list. Filename is arbitrary; using
  // "loom-workbench" (instead of a random hash) means reinstalls cleanly
  // overwrite the same entry.
  const registryDir = path.join(os.homedir(), '.cmake', 'packages', 'loom');
  await fs.mkdir(registryDir, { recursive: true });
  // Best-effort cleanup of the legacy "loomui" filename (predecessor name).
  try { await fs.unlink(path.join(registryDir, 'loomui')); } catch { /* ignore: didn't exist */ }
  const entryPath = path.join(registryDir, 'loom-workbench');
  await fs.writeFile(entryPath, configDir, 'utf8');
  return entryPath;
}

async function unregisterCmakePackage(): Promise<string> {
  if (process.platform === 'win32') {
    const key = 'HKCU\\Software\\Kitware\\CMake\\Packages\\loom';
    try { await exec(`reg delete "${key}" /v "loom-workbench" /f`); } catch { /* ignore */ }
    try { await exec(`reg delete "${key}" /v "loomui" /f`); } catch { /* ignore */ }
    return key;
  }

  const registryDir = path.join(os.homedir(), '.cmake', 'packages', 'loom');
  try { await fs.unlink(path.join(registryDir, 'loom-workbench')); } catch { /* ignore */ }
  try { await fs.unlink(path.join(registryDir, 'loomui')); } catch { /* ignore */ }
  return registryDir;
}

// ---------- helpers ----------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'LoomUI-vscode-extension',
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function downloadWithProgress(
  url: string,
  destination: string,
  totalBytes: number,
  filename: string,
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading ${filename}…`,
      cancellable: false,
    },
    async (progress) => {
      const res = await fetch(url, { headers: { 'User-Agent': 'LoomUI-vscode-extension' } });
      if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText}`);

      const file = fsSync.createWriteStream(destination);
      let written = 0;
      let lastReport = 0;
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          file.write(value);
          written += value.length;
          // Throttle progress reports to once per ~256kb to keep the UI calm.
          if (written - lastReport > 256 * 1024) {
            const pct = totalBytes > 0 ? (written / totalBytes) * 100 : 0;
            progress.report({
              increment: ((written - lastReport) / totalBytes) * 100,
              message: `${formatBytes(written)} / ${formatBytes(totalBytes)} (${pct.toFixed(0)}%)`,
            });
            lastReport = written;
          }
        }
      } finally {
        await new Promise<void>((resolve) => file.end(resolve));
      }
    },
  );
}

async function extractArchive(archive: string, dest: string): Promise<void> {
  // Both `tar -xzf` and `tar -xJf` work on macOS/Linux and Windows 10 1803+.
  // For .zip we'd need a different command; .tar.gz is the convention here.
  if (archive.endsWith('.zip')) {
    if (process.platform === 'win32') {
      await exec(`powershell -NoProfile -Command "Expand-Archive -Path '${archive}' -DestinationPath '${dest}' -Force"`);
    } else {
      await exec(`unzip -o -q "${archive}" -d "${dest}"`);
    }
    return;
  }
  // tar handles .tar.gz, .tgz, .tar.xz transparently with -xaf on macOS;
  // be explicit for portability.
  const flag = archive.endsWith('.xz') ? '-xJf' : '-xzf';
  await exec(`tar ${flag} "${archive}" -C "${dest}"`);
}

/** Locate the loom binary at the root or one level deep inside `dir`. */
async function findBinary(dir: string): Promise<string | undefined> {
  const exeName = process.platform === 'win32' ? 'loom.exe' : 'loom';
  const direct = path.join(dir, exeName);
  if (fsSync.existsSync(direct)) return direct;

  // Common conventions: loom-<version>/loom or loom-<version>/bin/loom.
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const sub = path.join(dir, entry);
    let stat;
    try { stat = await fs.stat(sub); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const candidates = [
      path.join(sub, exeName),
      path.join(sub, 'bin', exeName),
    ];
    for (const c of candidates) {
      if (fsSync.existsSync(c)) return c;
    }
  }
  return undefined;
}

/** Locate a `modules/` (or `lib/modules/`) directory under `dir`. */
async function findModulesDir(dir: string): Promise<string | undefined> {
  const root = path.join(dir, 'modules');
  if (fsSync.existsSync(root)) return root;
  let entries: string[];
  try { entries = await fs.readdir(dir); } catch { return undefined; }
  for (const entry of entries) {
    const sub = path.join(dir, entry);
    const candidates = [
      path.join(sub, 'modules'),
      path.join(sub, 'lib', 'modules'),
    ];
    for (const c of candidates) {
      if (fsSync.existsSync(c)) return c;
    }
  }
  return undefined;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

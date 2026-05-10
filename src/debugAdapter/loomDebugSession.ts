import {
  DebugSession,
  InitializedEvent,
  StoppedEvent,
  TerminatedEvent,
  Thread,
  StackFrame,
  Scope,
  Handles,
  OutputEvent,
  InvalidatedEvent,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';

import type { LoomClient } from '../api/client';
import type { LiveStream } from '../api/liveStream';
import {
  type DataSection,
  type ModuleDetail,
  type ModuleInfo,
  MODULE_STATES,
} from '../api/types';
import { encodeEvalName, jsonPointerEscape, deepSet } from '../util/jsonValue';

const FAKE_THREAD_ID = 1;
const INVALIDATE_DEBOUNCE_MS = 500;

interface VarHandle {
  kind: 'modules' | 'module' | 'section' | 'object' | 'array' | 'stats';
  moduleId?: string;
  section?: DataSection;
  path?: string[];
}

interface AttachArgs extends DebugProtocol.AttachRequestArguments {
  url?: string;
}

export class LoomDebugSession extends DebugSession {
  private readonly handles = new Handles<VarHandle>();
  private modules: ModuleInfo[] = [];
  private readonly details = new Map<string, ModuleDetail>();
  private readonly subscribed = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private invalidateTimer: NodeJS.Timeout | null = null;
  private readonly liveDisposables: { dispose(): void }[] = [];

  constructor(
    private readonly client: LoomClient,
    private readonly live: LiveStream,
  ) {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  protected override initializeRequest(
    response: DebugProtocol.InitializeResponse,
    _args: DebugProtocol.InitializeRequestArguments,
  ): void {
    response.body = response.body || {};
    // We deliberately do NOT advertise supportsSetVariable. Inline edit in
    // the Variables view gets clobbered when an InvalidatedEvent races a
    // user's keystrokes. Instead, the right-click "Loom: Set Value..."
    // command opens a modal InputBox — safe under live invalidation.
    response.body.supportsSetVariable = false;
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportTerminateDebuggee = false;
    response.body.supportsValueFormattingOptions = false;
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected override configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    _args: DebugProtocol.ConfigurationDoneArguments,
  ): void {
    this.sendResponse(response);
    // VSCode only asks for threads/scopes/variables once execution is
    // "stopped" at a frame. We're not really executing anything, but we
    // park the fake thread in a permanent paused state so the Variables
    // view fills in with module data.
    this.sendEvent(new StoppedEvent('pause', FAKE_THREAD_ID));
  }

  protected override async attachRequest(
    response: DebugProtocol.AttachResponse,
    _args: AttachArgs,
  ): Promise<void> {
    try {
      this.modules = await this.client.getModules();
      this.sendOutput(`Connected to Loom (${this.modules.length} module${this.modules.length === 1 ? '' : 's'}).\n`);
      // Prefetch every module's detail in parallel so expanding any
      // module in the Variables view is instant rather than racing a REST
      // round-trip after the click.
      await Promise.all(this.modules.map((m) => this.ensureDetail(m.id)));
    } catch (e) {
      this.sendOutput(`Failed to fetch modules: ${(e as Error).message}\n`, 'stderr');
    }

    this.pollTimer = setInterval(() => void this.pollModules(), 5000);

    this.liveDisposables.push(
      this.live.onLive((u) => {
        for (const d of this.details.values()) {
          const live = u.modules[d.id];
          if (!live) continue;
          if (live.summary) d.data.summary = live.summary;
          if (live.stats)   d.stats = live.stats;
        }
        this.scheduleInvalidate();
      }),
      this.live.onRuntime((u) => {
        for (const [id, live] of Object.entries(u.modules)) {
          const d = this.details.get(id);
          if (!d) continue;
          d.data.runtime = live.runtime;
        }
        this.scheduleInvalidate();
      }),
    );

    this.sendResponse(response);
  }

  protected override threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: [new Thread(FAKE_THREAD_ID, 'Loom')] };
    this.sendResponse(response);
  }

  protected override stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    _args: DebugProtocol.StackTraceArguments,
  ): void {
    response.body = { stackFrames: [new StackFrame(0, 'Modules')], totalFrames: 1 };
    this.sendResponse(response);
  }

  protected override scopesRequest(
    response: DebugProtocol.ScopesResponse,
    _args: DebugProtocol.ScopesArguments,
  ): void {
    // Single 'Modules' scope so VSCode auto-expands it on first stop —
    // the module list is visible immediately without any user click.
    // Each module appears as a child variable; expanding a module reveals
    // its sections (config/recipe/runtime/summary) and metadata.
    const ref = this.handles.create({ kind: 'modules' });
    response.body = { scopes: [new Scope('Modules', ref, false)] };
    this.sendResponse(response);
  }

  protected override async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): Promise<void> {
    const handle = this.handles.get(args.variablesReference);
    if (!handle) {
      response.body = { variables: [] };
      this.sendResponse(response);
      return;
    }
    response.body = { variables: await this.varsFor(handle) };
    this.sendResponse(response);
  }

  private async varsFor(h: VarHandle): Promise<DebugProtocol.Variable[]> {
    if (h.kind === 'modules') {
      return this.modules
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((m) => ({
          name: m.id,
          value: MODULE_STATES[m.state] ?? `state ${m.state}`,
          variablesReference: this.handles.create({ kind: 'module', moduleId: m.id }),
          presentationHint: { attributes: ['readOnly'] },
        }));
    }

    if (!h.moduleId) return [];

    if (h.kind === 'module') {
      const detail = await this.ensureDetail(h.moduleId);
      if (!detail) return [];
      const out: DebugProtocol.Variable[] = [];
      out.push(this.readonly('id', detail.id));
      out.push(this.readonly('class', detail.className));
      out.push(this.readonly('version', detail.version));
      out.push(this.readonly('state', MODULE_STATES[detail.state] ?? `${detail.state}`));
      if (detail.cyclicClass) out.push(this.readonly('cyclic_class', detail.cyclicClass));
      if (detail.stats) {
        out.push({
          name: 'stats',
          value: '{...}',
          variablesReference: this.handles.create({ kind: 'stats', moduleId: h.moduleId }),
          presentationHint: { attributes: ['readOnly'] },
        });
      }
      for (const section of ['config', 'recipe', 'runtime', 'summary'] as const) {
        const data = detail.data[section];
        out.push({
          name: section,
          value: summarize(data),
          variablesReference: this.handles.create({
            kind: 'section', moduleId: h.moduleId, section, path: [],
          }),
          presentationHint: section === 'summary'
            ? { attributes: ['readOnly'] }
            : undefined,
        });
      }
      return out;
    }

    if (h.kind === 'stats') {
      const detail = this.details.get(h.moduleId);
      if (!detail?.stats) return [];
      return Object.entries(detail.stats).map(([k, v]) => this.readonly(k, String(v)));
    }

    if ((h.kind === 'section' || h.kind === 'object' || h.kind === 'array') && h.section) {
      const detail = await this.ensureDetail(h.moduleId);
      if (!detail) return [];
      const data = traverse(detail.data[h.section], h.path ?? []);
      return this.objectToVars(data, h.moduleId, h.section, h.path ?? []);
    }

    return [];
  }

  private objectToVars(
    value: unknown,
    moduleId: string,
    section: DataSection,
    path: string[],
  ): DebugProtocol.Variable[] {
    if (value == null || typeof value !== 'object') return [];
    const entries: [string, unknown][] = Array.isArray(value)
      ? value.map((v, i) => [`[${i}]`, v])
      : Object.entries(value as Record<string, unknown>);
    return entries.map(([name, child]) => this.makeVar(name, child, moduleId, section, path));
  }

  private makeVar(
    name: string,
    value: unknown,
    moduleId: string,
    section: DataSection,
    parentPath: string[],
  ): DebugProtocol.Variable {
    const segName = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
    const path = [...parentPath, segName];
    const readOnly = section === 'summary';

    if (value === null || typeof value !== 'object') {
      // Primitive leaf: set evaluateName so the right-click "Set Value"
      // command can decode (moduleId, section, path) without us having to
      // serialise variable references in another way.
      return {
        name,
        value: formatPrimitive(value),
        variablesReference: 0,
        presentationHint: readOnly ? { attributes: ['readOnly'] } : undefined,
        evaluateName: readOnly ? undefined : encodeEvalName(moduleId, section, path),
      };
    }

    const ref = this.handles.create({
      kind: Array.isArray(value) ? 'array' : 'object',
      moduleId, section, path,
    });
    return {
      name,
      value: summarize(value),
      variablesReference: ref,
      presentationHint: readOnly ? { attributes: ['readOnly'] } : undefined,
    };
  }

  private readonly(name: string, value: string): DebugProtocol.Variable {
    return {
      name,
      value,
      variablesReference: 0,
      presentationHint: { attributes: ['readOnly'] },
    };
  }

  /** Apply a value edit triggered by the `loom.modules.setValue` command.
   *  PATCHes the server, mirrors the change in the local cache, then
   *  fires Invalidated so the Variables view shows the new value. */
  async applyEdit(moduleId: string, section: DataSection, path: string[], value: unknown): Promise<void> {
    if (section === 'summary') throw new Error('summary is server-derived and read-only.');
    const ptr = '/' + path.map(jsonPointerEscape).join('/');
    await this.client.patchModuleData(moduleId, section, ptr, value);
    const detail = this.details.get(moduleId);
    if (detail) deepSet(detail.data[section], path, value);
    this.refresh();
  }

  protected override disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    _args: DebugProtocol.DisconnectArguments,
  ): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.invalidateTimer) { clearTimeout(this.invalidateTimer); this.invalidateTimer = null; }
    for (const d of this.liveDisposables) d.dispose();
    this.liveDisposables.length = 0;
    for (const id of this.subscribed) this.live.unsubscribeRuntime(id);
    this.subscribed.clear();
    this.sendResponse(response);
    this.sendEvent(new TerminatedEvent());
  }

  private async pollModules(): Promise<void> {
    try {
      const next = await this.client.getModules();
      const idsBefore = new Set(this.modules.map((m) => m.id));
      const idsAfter = new Set(next.map((m) => m.id));
      this.modules = next;
      // Drop cached details for modules that disappeared.
      for (const id of idsBefore) {
        if (!idsAfter.has(id)) {
          this.details.delete(id);
          if (this.subscribed.delete(id)) this.live.unsubscribeRuntime(id);
        }
      }
      this.sendInvalidated();
    } catch {
      // Server probably down — leave cache alone.
    }
  }

  private async ensureDetail(moduleId: string): Promise<ModuleDetail | null> {
    let d = this.details.get(moduleId);
    if (!d) {
      try {
        d = await this.client.getModule(moduleId);
        this.details.set(moduleId, d);
      } catch (e) {
        this.sendOutput(`Failed to fetch ${moduleId}: ${(e as Error).message}\n`, 'stderr');
        return null;
      }
    }
    if (!this.subscribed.has(moduleId)) {
      this.subscribed.add(moduleId);
      this.live.subscribeRuntime(moduleId);
    }
    return d;
  }

  /** Manual refresh — fires Invalidated immediately. */
  refresh(): void {
    if (this.invalidateTimer) { clearTimeout(this.invalidateTimer); this.invalidateTimer = null; }
    this.sendInvalidated();
  }

  private scheduleInvalidate(): void {
    if (this.invalidateTimer) return;
    this.invalidateTimer = setTimeout(() => {
      this.invalidateTimer = null;
      this.sendInvalidated();
    }, INVALIDATE_DEBOUNCE_MS);
  }

  private sendInvalidated(): void {
    this.sendEvent(new InvalidatedEvent(['variables'], FAKE_THREAD_ID));
  }

  private sendOutput(text: string, category: 'console' | 'stdout' | 'stderr' = 'console'): void {
    this.sendEvent(new OutputEvent(text, category));
  }
}

// ---------- helpers ----------

function traverse(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function summarize(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === 'object') return `Object(${Object.keys(value as object).length})`;
  return formatPrimitive(value);
}

function formatPrimitive(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

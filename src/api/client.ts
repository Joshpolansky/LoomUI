import type {
  ModuleInfo,
  ModuleDetail,
  AvailableModule,
  ClassInfo,
  ServiceInfo,
  ServiceCallResult,
  DataSection,
  IOMapping,
  FaultSummary,
  FaultDetail,
} from './types';
import type { OpcuaClient } from './opcuaClient';
import { moduleNode, ptrToFieldPath } from './nodeId';

export class LoomClient {
  /** Set in extension.ts so section reads/writes go through the OPC-UA facade.
   *  Management endpoints (modules/scheduler/bus/io-mappings) stay on REST. */
  private opc: OpcuaClient | undefined;

  constructor(private getBaseUrl: () => string) {}

  attachOpcua(opc: OpcuaClient): void { this.opc = opc; }

  private base(): string {
    return this.getBaseUrl().replace(/\/+$/, '');
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base()}${path}`, init);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
    return (await res.json()) as T;
  }

  // --- modules ---
  getModules():            Promise<ModuleInfo[]>      { return this.json('/api/modules'); }
  getModule(id: string):   Promise<ModuleDetail>      { return this.json(`/api/modules/${encodeURIComponent(id)}`); }
  getAvailableModules():   Promise<AvailableModule[]> { return this.json('/api/modules/available'); }

  reloadModule(id: string) {
    return this.json<{ ok: boolean; message?: string }>(
      `/api/modules/${encodeURIComponent(id)}/reload`,
      { method: 'POST' },
    );
  }

  removeModule(id: string) {
    return this.json<{ ok: boolean }>(
      `/api/modules/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  }

  instantiateModule(so: string, id: string) {
    return this.json<{ ok: boolean; id: string }>('/api/modules/instantiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ so, id }),
    });
  }

  saveModuleConfig(id: string) {
    return this.json<{ ok: boolean }>(
      `/api/modules/${encodeURIComponent(id)}/config/save`,
      { method: 'POST' },
    );
  }

  loadModuleConfig(id: string) {
    return this.json<Record<string, unknown>>(
      `/api/modules/${encodeURIComponent(id)}/config/load`,
      { method: 'POST' },
    );
  }

  async getModuleData(id: string, section: DataSection): Promise<Record<string, unknown>> {
    if (this.opc) {
      const { value } = await this.opc.read(moduleNode(id, section));
      return (value ?? {}) as Record<string, unknown>;
    }
    return this.json<Record<string, unknown>>(
      `/api/modules/${encodeURIComponent(id)}/data/${section}`,
    );
  }

  async patchModuleData(
    id: string, section: DataSection, ptr: string, value: unknown,
  ): Promise<{ ok: boolean }> {
    if (this.opc) {
      const ok = await this.opc.write(moduleNode(id, section, ptrToFieldPath(ptr)), value);
      return { ok };
    }
    return this.json<{ ok: boolean }>(
      `/api/modules/${encodeURIComponent(id)}/data/${section}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ptr, value }),
      },
    );
  }

  // --- scheduler ---
  getSchedulerClasses(): Promise<ClassInfo[]> { return this.json('/api/scheduler/classes'); }

  createSchedulerClass(def: {
    name: string;
    period_us: number;
    priority: number;
    cpu_affinity: number;
    spin_us: number;
  }): Promise<{ ok: boolean }> {
    return this.json('/api/scheduler/classes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(def),
    });
  }

  updateSchedulerClass(
    name: string,
    patch: Partial<Pick<ClassInfo, 'period_us' | 'priority' | 'cpu_affinity' | 'spin_us'>>,
  ): Promise<{ ok: boolean }> {
    return this.json(`/api/scheduler/classes/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  reassignModuleClass(
    moduleId: string,
    className: string,
    order?: number,
  ): Promise<{ ok: boolean }> {
    return this.json('/api/scheduler/reassign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moduleId, class: className, ...(order != null ? { order } : {}) }),
    });
  }

  async uploadModule(
    filename: string,
    content: Buffer | Uint8Array,
  ): Promise<{ ok: boolean; id?: string; error?: string }> {
    const res = await fetch(`${this.base()}/api/modules/upload`, {
      method: 'POST',
      headers: { 'X-Filename': filename, 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as { ok: boolean; id?: string; error?: string };
  }

  // --- bus ---
  getBusServices(): Promise<ServiceInfo[]> { return this.json('/api/bus/services'); }
  getBusTopics():   Promise<string[]>      { return this.json('/api/bus/topics'); }

  callBusService(name: string, request: string = '{}'): Promise<ServiceCallResult> {
    // Preserve '/' separators between module ID and service name; encode each segment.
    const encoded = name.split('/').map(encodeURIComponent).join('/');
    return this.json(`/api/bus/call/${encoded}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: request,
    });
  }

  // --- faults (crash diagnostics) ---
  getFaults():          Promise<FaultSummary[]> { return this.json('/api/faults'); }
  getFault(id: string): Promise<FaultDetail>    { return this.json(`/api/faults/${encodeURIComponent(id)}`); }

  // --- io mappings ---
  getMappings(): Promise<IOMapping[]> { return this.json('/api/io-mappings'); }

  createMapping(m: { source: string; target: string; enabled: boolean }): Promise<{ ok: boolean; index?: number }> {
    return this.json('/api/io-mappings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(m),
    });
  }

  updateMapping(
    index: number,
    patch: { source: string; target: string; enabled: boolean },
  ): Promise<{ ok: boolean }> {
    return this.json(`/api/io-mappings/${index}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  deleteMapping(index: number): Promise<{ ok: boolean }> {
    return this.json(`/api/io-mappings/${index}`, { method: 'DELETE' });
  }

  resolveMappings(): Promise<{ ok: boolean }> {
    return this.json('/api/io-mappings/resolve', { method: 'POST' });
  }
}

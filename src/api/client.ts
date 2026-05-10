import type {
  ModuleInfo,
  ModuleDetail,
  AvailableModule,
  ClassInfo,
  ServiceInfo,
  ServiceCallResult,
  DataSection,
} from './types';

export class LoomClient {
  constructor(private getBaseUrl: () => string) {}

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

  getModuleData(id: string, section: DataSection) {
    return this.json<Record<string, unknown>>(
      `/api/modules/${encodeURIComponent(id)}/data/${section}`,
    );
  }

  patchModuleData(id: string, section: DataSection, ptr: string, value: unknown) {
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
}

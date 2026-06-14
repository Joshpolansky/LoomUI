// OPC-UA NodeId helpers for the mapp Connect-compatible facade.
//
// A node is addressed as "ns=1;s=<path>" where <path> mirrors the runtime's
// data tree (see Loom/runtime/include/loom/opcua_rest_nodeid.h):
//
//   /module/<id>/<section>                  — a whole section (config|recipe|runtime|summary)
//   /module/<id>/<section>/<field/pointer>  — a leaf/sub-tree within a section
//   /module/<id>/stats                      — scheduler task stats (read-only)
//   /scheduler/classes/<name>               — class stats (read-only)
//
// Mirrors Loom/frontend/src/api/machine.ts so the extension and the React app
// address the same nodes identically.

import type { DataSection } from './types';

/** Node for a module section, or a field within it. `fieldPath` is '/'-joined
 *  segments (no leading slash), matching the runtime's tag-table keys. */
export function moduleNode(id: string, section: DataSection, fieldPath?: string): string {
  const base = `ns=1;s=/module/${id}/${section}`;
  const clean = (fieldPath ?? '').replace(/^\/+/, '').replace(/\/+/g, '/');
  return clean ? `${base}/${clean}` : base;
}

/** Node for a module's scheduler task stats. */
export function statsNode(id: string): string {
  return `ns=1;s=/module/${id}/stats`;
}

/** Node for a scheduler class's live stats. */
export function classNode(name: string): string {
  return `ns=1;s=/scheduler/classes/${name}`;
}

/** Convert a JSON Pointer (e.g. "/foo/bar", "/arr/0") to a tag-table field
 *  path (e.g. "foo/bar", "arr/0") by dropping the leading slash. The runtime's
 *  tag keys are '/'-separated with numeric array indices, so this is a 1:1 map
 *  for the pointers the UI produces (no '~0'/'~1' escapes in practice). */
export function ptrToFieldPath(ptr: string): string {
  return ptr.replace(/^\/+/, '');
}

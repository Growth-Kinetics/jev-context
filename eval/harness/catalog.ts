// CATALOG: skill bodies + tool namespaces, from committed fixtures with recorded provenance.
// The extension will own its live catalog scan; the harness replays against this frozen
// snapshot so reports are byte-deterministic across machines.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface ToolSpec {
  bytes: number;
  estimated: boolean;
}

export interface Catalog {
  skills: Record<string, number>;
  coreTools: Record<string, ToolSpec>;
  namespaces: Record<string, string[]>;
  defaultToolSchemaBytes: number;
}

interface CatalogFixture {
  skills: Record<string, number>;
  core: Record<string, ToolSpec>;
  namespaces: Record<string, string[]>;
  defaultToolSchemaBytes: number;
}

export function loadCatalog(
  skillCatalogPath = new URL("../fixtures/skill-catalog.json", import.meta.url)
    .pathname,
  toolSchemasPath = new URL("../fixtures/tool-schemas.json", import.meta.url)
    .pathname,
): Catalog {
  const skills = JSON.parse(
    readFileSync(skillCatalogPath, "utf8"),
  ) as CatalogFixture;
  const tools = JSON.parse(
    readFileSync(toolSchemasPath, "utf8"),
  ) as CatalogFixture;
  return {
    skills: skills.skills,
    coreTools: tools.core,
    namespaces: tools.namespaces,
    defaultToolSchemaBytes: tools.defaultToolSchemaBytes,
  };
}

/** namespace of a tool name; core tools map to the always-on "core" namespace */
export function namespaceOf(toolName: string, catalog: Catalog): string {
  if (toolName in catalog.coreTools) return "core";
  for (const [ns, tools] of Object.entries(catalog.namespaces)) {
    if (tools.includes(toolName)) return ns;
  }
  return "unmapped";
}

/** every non-core namespace (schema cost surfaced by nozzle 2 when active) */
export function routedNamespaces(catalog: Catalog): string[] {
  return Object.keys(catalog.namespaces);
}

export function namespaceBytes(ns: string, catalog: Catalog): ToolSpec {
  if (ns === "core") {
    const bytes = Object.values(catalog.coreTools).reduce(
      (acc, t) => acc + t.bytes,
      0,
    );
    return { bytes, estimated: false };
  }
  const tools = catalog.namespaces[ns] ?? [];
  const bytes = tools.length * catalog.defaultToolSchemaBytes;
  return { bytes, estimated: true };
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

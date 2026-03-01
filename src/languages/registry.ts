import type { ChunkMetadata, ImportInfo } from "../types.ts";

export interface LanguageSupport {
  /** File extensions this language handles, e.g. [".cs"] */
  extensions: string[];
  /** WASM grammar name — matches filename in tree-sitter-wasms/out/, e.g. "c_sharp" */
  grammarName: string;
  /** Optional per-extension grammar override. If not set, grammarName is used for all extensions. */
  grammarForExtension?: Record<string, string>;
  /** Extract metadata from a top-level AST node. Return null to skip. */
  extractMetadata(node: any, lines: string[]): ChunkMetadata | null;
  /** Extract import info from an import-like node. Return null if not an import. */
  extractImport(node: any): ImportInfo | null;
  /** AST node types that represent imports (collected, not chunked) */
  importNodeTypes: string[];
  /** AST node types that should be unwrapped (their children processed instead) */
  unwrapNodeTypes: string[];
}

const registry = new Map<string, LanguageSupport>();

export function registerLanguage(name: string, support: LanguageSupport): void {
  registry.set(name, support);
}

export function getLanguageSupport(name: string): LanguageSupport {
  const support = registry.get(name);
  if (!support) {
    const available = [...registry.keys()].join(", ");
    throw new Error(`Unknown language: "${name}". Available: ${available}`);
  }
  return support;
}

export function getAvailableLanguages(): string[] {
  return [...registry.keys()];
}

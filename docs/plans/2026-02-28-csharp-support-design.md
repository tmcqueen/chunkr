# C# Language Support + Language Config

## Problem

chunkr only supports TypeScript/JavaScript. Extensions and grammar are hardcoded. Need to support C# and make language selection configurable per-project.

## Design

### Config File

`chunkr init --lang csharp` creates `.chunkr.json` in the project root:

```json
{ "lang": "csharp" }
```

Omitting `--lang` defaults to `typescript`. All commands read this config to determine behavior.

### Language Registry

New `src/languages/` directory:

- `registry.ts` — maps language name to a `LanguageSupport` object
- `typescript.ts` — existing TS/JS extraction logic, moved from parser.ts
- `csharp.ts` — new C# extraction logic

```typescript
interface LanguageSupport {
  extensions: string[];
  grammarName: string;        // matches WASM filename (e.g. "c_sharp")
  extractMetadata(node: any, lines: string[]): ChunkMetadata | null;
  extractImport(node: any): ImportInfo | null;
}
```

### C# Node Type Mapping

| C# Node Type | Chunk Type | Notes |
|---|---|---|
| `namespace_declaration` | Unwrap | Recurse into children |
| `file_scoped_namespace_declaration` | Unwrap | Modern `namespace Foo;` syntax |
| `class_declaration` | class | Extract methods, properties, fields |
| `interface_declaration` | interface | Extract method signatures |
| `enum_declaration` | enum | Extract members |
| `struct_declaration` | struct | Extract members |
| `record_declaration` | record | Extract members |
| `method_declaration` | method | Top-level/static methods |
| `using_directive` | import | Collected, not chunked |

Key difference from TS: C# wraps declarations in namespaces, so the parser must unwrap namespace nodes and recurse.

### `chunkr agent` Command

Outputs a short markdown document for LLM consumption. Reads `.chunkr.json` and DB summary to include project-specific context (configured language, file extensions, indexed file/chunk counts). Explains available commands and recommended workflow.

### Changes to Existing Files

- **parser.ts** — thin dispatcher; loads grammar + extraction module from registry based on config
- **indexer.ts** — `scanAllFiles` reads extensions from language config instead of hardcoding globs; adds `obj/`, `bin/` to skip list
- **cli.ts** — `init` accepts `--lang <name>`, writes `.chunkr.json`; adds `agent` command
- **db.ts** — no changes

### Excluded Directories

Add `obj/`, `bin/` to skip list (C# build artifacts) alongside existing `node_modules/`, `dist/`, `out/`, `.worktrees/`.

# chunkr

Semantic code indexer that parses source files into chunks and stores them in SQLite, so LLMs can query what they need instead of reading entire files.

## About

LLMs waste context window tokens reading full source files when they only need one class or function. chunkr solves this by using tree-sitter to parse source files into semantic chunks (classes, functions, interfaces, enums) and storing them with YAML metadata in a local SQLite database. An LLM can then browse file metadata, pick the chunks it needs, and retrieve just those — saving tokens and improving focus.

chunkr is git-aware and incremental. After the first full index, subsequent runs only re-parse changed files. Chunk descriptions (added by LLMs or humans) survive re-indexing as long as the chunk body hasn't changed.

## Features

- **Tree-sitter parsing** via WASM — no native bindings, runs anywhere Bun runs
- **Incremental indexing** — uses `git diff` to detect changes, MD5 hashes to skip unchanged chunks
- **Multi-language** — TypeScript/JavaScript and C# supported, extensible to 30+ languages via `tree-sitter-wasms`
- **Per-project config** — language set at init time, stored in `.chunkr.json`
- **LLM-friendly output** — YAML metadata, markdown agent guide, designed for tool use
- **Description persistence** — LLM-written chunk descriptions survive re-indexing

## Installation

Requires [Bun](https://bun.sh/) v1.0+.

```bash
git clone https://github.com/tmcqueen/chunkr.git
cd chunkr
bun install
bun link
```

This makes `chunkr` available globally.

## Usage

### Initialize a project

```bash
cd your-project

# TypeScript/JavaScript (default)
chunkr init

# C# project
chunkr init --lang csharp
```

This creates `.chunkr.db` (SQLite database) and `.chunkr.json` (language config). Add `.chunkr.db` to your `.gitignore`; commit `.chunkr.json`.

### Index files

```bash
chunkr index
```

First run does a full scan. Subsequent runs are incremental — only files changed since the last index are re-parsed.

### Query metadata

```bash
# See all chunks in a file (no source bodies)
chunkr query src/parser.ts

# Output:
# --- chunk 0 (lines 1-15) ---
# name: parseFile
# type: function
# params: [filePath: string, source: string]
# returns: ChunkRecord[]
```

### Retrieve a chunk

```bash
# By start line
chunkr chunk src/parser.ts 1

# By chunk index
chunkr chunk src/parser.ts 0
```

### Project overview

```bash
chunkr summary

# Files: 42
# Chunks: 187
# Languages:
#   .cs: 42 files
```

### LLM agent guide

```bash
chunkr agent
```

Outputs a markdown document explaining chunkr's commands and workflow — designed to be piped into an LLM's system prompt or tool description.

### Other commands

```bash
# Files changed since last index
chunkr status

# Update a chunk's description from stdin
echo "Parses SIP request headers" | chunkr describe src/parser.ts 0
```

## Supported Languages

| Language | `--lang` value | Extensions |
|----------|---------------|------------|
| TypeScript/JavaScript | `typescript` (default) | `.ts`, `.tsx`, `.js`, `.jsx` |
| C# | `csharp` | `.cs` |

Adding a new language requires one file (`src/languages/<name>.ts`) that maps tree-sitter AST nodes to chunk metadata. The `tree-sitter-wasms` package includes grammars for Python, Go, Java, Rust, Ruby, and 30+ others.

## How It Works

```
source file → tree-sitter WASM parser → AST → language module → chunks → SQLite
```

1. **tree-sitter** parses source into an AST using WASM grammars (no native bindings)
2. **Language modules** walk the AST, extracting metadata: name, type, params, returns, children
3. **Chunks** are stored in SQLite with their source body, YAML metadata, and an MD5 hash
4. **Incremental indexing** compares hashes — unchanged chunks keep their metadata (including descriptions)

### File structure

```
src/
  cli.ts              — CLI entry point
  config.ts           — .chunkr.json read/write
  db.ts               — SQLite layer (prepared statements, transactions)
  indexer.ts           — Git-aware incremental indexing
  parser.ts            — Language-agnostic tree-sitter dispatcher
  yaml.ts              — Write-only YAML serializer
  types.ts             — Shared interfaces
  languages/
    registry.ts        — LanguageSupport interface + registration
    typescript.ts      — TypeScript/JavaScript extraction
    csharp.ts          — C# extraction
```

## Adding a Language

Create `src/languages/<name>.ts` implementing the `LanguageSupport` interface:

```typescript
import { registerLanguage } from "./registry.ts";
import type { LanguageSupport } from "./registry.ts";

const myLang: LanguageSupport = {
  extensions: [".py"],
  grammarName: "python",           // matches tree-sitter-wasms filename
  extractMetadata(node, lines) {   // map AST nodes → ChunkMetadata
    // ...
  },
  extractImport(node) { /* ... */ },
  importNodeTypes: ["import_statement"],
  unwrapNodeTypes: [],             // e.g. ["namespace_declaration"] for C#
};

registerLanguage("python", myLang);
```

Then add `import "./languages/<name>.ts"` to `src/parser.ts`. That's it — the CLI, indexer, and config system pick it up automatically.

## License

MIT

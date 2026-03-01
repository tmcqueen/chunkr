# C# Language Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add C# language support to chunkr with a per-project config system and an `agent` command for LLM self-discovery.

**Architecture:** Extract the existing TS/JS extraction logic into a language module, add a parallel C# module, and wire them together through a registry. A `.chunkr.json` config file (created at `init` time) determines which language module to use. The parser becomes a thin dispatcher.

**Tech Stack:** TypeScript (Bun runtime), web-tree-sitter (WASM), tree-sitter-wasms (includes `tree-sitter-c_sharp.wasm`), bun:sqlite

---

### Task 1: LanguageSupport Interface and Registry

**Files:**
- Create: `src/languages/registry.ts`

**Step 1: Write the registry with LanguageSupport interface**

```typescript
// src/languages/registry.ts
import type { ChunkMetadata, ImportInfo } from "../types.ts";

export interface LanguageSupport {
  /** File extensions this language handles, e.g. [".cs"] */
  extensions: string[];
  /** WASM grammar name — matches filename in tree-sitter-wasms/out/, e.g. "c_sharp" */
  grammarName: string;
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
```

**Step 2: Commit**

```bash
git add src/languages/registry.ts
git commit -m "feat: add LanguageSupport interface and registry"
```

---

### Task 2: Extract TypeScript Language Module

Move the existing extraction logic from `src/parser.ts` into `src/languages/typescript.ts` and register it.

**Files:**
- Create: `src/languages/typescript.ts`

**Step 1: Create the TypeScript language module**

Move these functions from `parser.ts` into `src/languages/typescript.ts`:
- `extractMetadata` (rename the switch-case function)
- `extractClass`, `extractFunction`, `extractLexical`, `extractEnum`, `extractInterface`, `extractTypeAlias`
- `extractParams`, `extractImport`

Wire them into a `LanguageSupport` object:

```typescript
// src/languages/typescript.ts
import { registerLanguage } from "./registry.ts";
import type { ChunkMetadata, ChildInfo, ImportInfo } from "../types.ts";

// ... (move all extract* functions here unchanged from parser.ts)

const typescript: LanguageSupport = {
  extensions: [".ts", ".tsx", ".js", ".jsx"],
  grammarName: "typescript", // Note: .tsx uses "tsx", .js/.jsx use "javascript"
  extractMetadata,
  extractImport,
  importNodeTypes: ["import_statement"],
  unwrapNodeTypes: [],
};

registerLanguage("typescript", typescript);
```

**Important detail:** The existing TS parser maps multiple extensions to different WASM grammars (`.ts` → `typescript`, `.tsx` → `tsx`, `.js`/`.jsx` → `javascript`). The `LanguageSupport.grammarName` field is the default, but `parser.ts` needs to handle this mapping. Add an optional `grammarForExtension` map to the TS module:

```typescript
// In the typescript language module, add:
export const extToGrammar: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
};
```

And update the `LanguageSupport` interface to include an optional override:

```typescript
// Add to LanguageSupport interface in registry.ts:
/** Optional per-extension grammar override. If not set, grammarName is used for all extensions. */
grammarForExtension?: Record<string, string>;
```

**Step 2: Verify existing tests still pass**

```bash
bun test
```

**Step 3: Commit**

```bash
git add src/languages/typescript.ts
git commit -m "feat: extract TypeScript language module from parser"
```

---

### Task 3: Create C# Language Module

**Files:**
- Create: `src/languages/csharp.ts`

**Step 1: Write the C# extraction module**

Based on the AST exploration, here are the exact C# tree-sitter node types and field names:

**Namespace unwrapping:**
- `namespace_declaration` — has `childForFieldName("body")` which is a `declaration_list` containing type declarations
- `file_scoped_namespace_declaration` — children are directly the type declarations (after the `qualified_name`)

**Type declarations (become chunks):**
- `class_declaration` — `name` field = identifier, `body` field = `declaration_list`, `bases` field = `base_list`
- `interface_declaration` — same structure as class
- `struct_declaration` — same structure as class
- `record_declaration` — `name` field, `parameters` field (for positional records), `body` field
- `enum_declaration` — `name` field, `body` field = `enum_member_declaration_list`

**Class/struct/interface members (become children):**
- `method_declaration` — `name` field, `type` field (return type), `parameters` field = `parameter_list`
- `constructor_declaration` — `name` field, `parameters` field
- `property_declaration` — `name` field, `type` field

**Imports:**
- `using_directive` — text is the full `using System.Collections.Generic;`

**Modifiers:**
- Each declaration can have `modifier` children with text like `public`, `private`, `static`, `abstract`, etc.

```typescript
// src/languages/csharp.ts
import { registerLanguage } from "./registry.ts";
import type { LanguageSupport } from "./registry.ts";
import type { ChunkMetadata, ChildInfo, ImportInfo } from "../types.ts";

function extractMetadata(node: any, lines: string[]): ChunkMetadata | null {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  const lineRange: [number, number] = [startLine, endLine];

  switch (node.type) {
    case "class_declaration":
      return extractTypeDecl(node, "class", lineRange);
    case "interface_declaration":
      return extractTypeDecl(node, "interface", lineRange);
    case "struct_declaration":
      return extractTypeDecl(node, "struct", lineRange);
    case "record_declaration":
      return extractRecord(node, lineRange);
    case "enum_declaration":
      return extractEnum(node, lineRange);
    case "method_declaration":
      return extractMethod(node, lineRange);
    case "global_statement":
      return {
        name: node.text.substring(0, 40).replace(/\n/g, " "),
        type: "expression",
        line_range: lineRange,
      };
    default:
      return {
        name: node.type,
        type: node.type,
        line_range: lineRange,
      };
  }
}

function extractTypeDecl(
  node: any,
  type: string,
  lineRange: [number, number]
): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  const children: ChildInfo[] = [];

  const body = node.childForFieldName("body");
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (!member) continue;

      if (member.type === "method_declaration") {
        const child = extractMethodChild(member);
        if (child) children.push(child);
      } else if (member.type === "constructor_declaration") {
        const child = extractConstructorChild(member);
        if (child) children.push(child);
      } else if (member.type === "property_declaration") {
        const child = extractPropertyChild(member);
        if (child) children.push(child);
      }
    }
  }

  // Extract base types
  const bases = node.childForFieldName("bases");
  const meta: ChunkMetadata = { name, type, line_range: lineRange };
  if (bases) {
    // base_list text is like ": IFoo, Bar" — strip the leading ": "
    meta.returns = bases.text.replace(/^:\s*/, "");
  }
  if (children.length > 0) meta.children = children;
  return meta;
}

function extractRecord(
  node: any,
  lineRange: [number, number]
): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  const params = extractParams(node.childForFieldName("parameters"));
  const meta: ChunkMetadata = { name, type: "record", line_range: lineRange };
  if (params.length > 0) meta.params = params;

  // Record can also have a body with members
  const children: ChildInfo[] = [];
  const body = node.childForFieldName("body");
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (!member) continue;
      if (member.type === "method_declaration") {
        const child = extractMethodChild(member);
        if (child) children.push(child);
      } else if (member.type === "property_declaration") {
        const child = extractPropertyChild(member);
        if (child) children.push(child);
      }
    }
  }
  if (children.length > 0) meta.children = children;
  return meta;
}

function extractEnum(
  node: any,
  lineRange: [number, number]
): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  return { name, type: "enum", line_range: lineRange };
}

function extractMethod(
  node: any,
  lineRange: [number, number]
): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  const returnType = node.childForFieldName("type")?.text;
  const params = extractParams(node.childForFieldName("parameters"));
  const meta: ChunkMetadata = { name, type: "method", line_range: lineRange };
  if (params.length > 0) meta.params = params;
  if (returnType) meta.returns = returnType;
  return meta;
}

function extractMethodChild(member: any): ChildInfo | null {
  const name = member.childForFieldName("name")?.text ?? "anonymous";
  const returnType = member.childForFieldName("type")?.text;
  const params = extractParams(member.childForFieldName("parameters"));
  const child: ChildInfo = {
    name,
    type: "method",
    line_range: [member.startPosition.row + 1, member.endPosition.row + 1],
  };
  if (params.length > 0) child.params = params;
  if (returnType) child.returns = returnType;
  return child;
}

function extractConstructorChild(member: any): ChildInfo | null {
  const name = member.childForFieldName("name")?.text ?? "anonymous";
  const params = extractParams(member.childForFieldName("parameters"));
  const child: ChildInfo = {
    name,
    type: "constructor",
    line_range: [member.startPosition.row + 1, member.endPosition.row + 1],
  };
  if (params.length > 0) child.params = params;
  return child;
}

function extractPropertyChild(member: any): ChildInfo | null {
  const name = member.childForFieldName("name")?.text ?? "anonymous";
  const propType = member.childForFieldName("type")?.text;
  const child: ChildInfo = {
    name,
    type: "property",
    line_range: [member.startPosition.row + 1, member.endPosition.row + 1],
  };
  if (propType) child.returns = propType;
  return child;
}

function extractParams(paramsNode: any): string[] {
  if (!paramsNode) return [];
  const params: string[] = [];
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    params.push(paramsNode.namedChild(i).text);
  }
  return params;
}

function extractImport(node: any): ImportInfo | null {
  if (node.type !== "using_directive") return null;
  // Extract the namespace name from "using System.Collections.Generic;"
  // The named child is typically an identifier or qualified_name
  let name = "";
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === "identifier" || child.type === "qualified_name") {
      name = child.text;
    }
  }
  if (name) return { name, from: name };
  return null;
}

const csharp: LanguageSupport = {
  extensions: [".cs"],
  grammarName: "c_sharp",
  extractMetadata,
  extractImport,
  importNodeTypes: ["using_directive"],
  unwrapNodeTypes: ["namespace_declaration", "file_scoped_namespace_declaration"],
};

registerLanguage("csharp", csharp);
```

**Step 2: Commit**

```bash
git add src/languages/csharp.ts
git commit -m "feat: add C# language module"
```

---

### Task 4: Refactor parser.ts to Use Registry

**Files:**
- Modify: `src/parser.ts` (full rewrite)

**Step 1: Rewrite parser.ts as a dispatcher**

The parser should:
1. Accept a language name (from config)
2. Load the right WASM grammar via the registry
3. Walk top-level AST nodes, delegating to the language module's `extractMetadata`
4. Handle namespace unwrapping using the language module's `unwrapNodeTypes`

```typescript
// src/parser.ts — rewritten as dispatcher
import type { ChunkRecord, ImportInfo } from "./types.ts";
import type { LanguageSupport } from "./languages/registry.ts";
import { getLanguageSupport } from "./languages/registry.ts";
import { toYaml } from "./yaml.ts";
import { resolve } from "path";

// Side-effect imports to register languages
import "./languages/typescript.ts";
import "./languages/csharp.ts";

// Lazy-initialized parser
let ParserClass: any;
let initPromise: Promise<void> | null = null;
const grammars: Map<string, any> = new Map();

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const WASM_DIR = resolve(PROJECT_ROOT, "node_modules/tree-sitter-wasms/out");

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const WTS = require("web-tree-sitter");
    await WTS.init();
    ParserClass = WTS;
  })();
  return initPromise;
}

async function getGrammar(grammarName: string): Promise<any> {
  if (grammars.has(grammarName)) return grammars.get(grammarName)!;
  await ensureInit();
  const wasmPath = resolve(WASM_DIR, `tree-sitter-${grammarName}.wasm`);
  const lang = await ParserClass.Language.load(wasmPath);
  grammars.set(grammarName, lang);
  return lang;
}

/** Get the grammar name for a specific file extension within a language. */
function getGrammarForFile(langSupport: LanguageSupport, filePath: string): string {
  const ext = "." + filePath.split(".").pop();
  if (langSupport.grammarForExtension?.[ext]) {
    return langSupport.grammarForExtension[ext];
  }
  return langSupport.grammarName;
}

export function getSupportedExtensions(langName: string): string[] {
  return getLanguageSupport(langName).extensions;
}

export function isSupported(langName: string, filePath: string): boolean {
  const ext = "." + filePath.split(".").pop();
  return getLanguageSupport(langName).extensions.includes(ext);
}

/** Parse a source file into chunks using the specified language. */
export async function parseFile(
  langName: string,
  filePath: string,
  source: string
): Promise<ChunkRecord[]> {
  const langSupport = getLanguageSupport(langName);
  const grammarName = getGrammarForFile(langSupport, filePath);

  await ensureInit();
  const grammar = await getGrammar(grammarName);
  const parser = new ParserClass();
  parser.setLanguage(grammar);

  const tree = parser.parse(source);
  const root = tree.rootNode;
  const lines = source.split("\n");

  const chunks: ChunkRecord[] = [];
  const fileImports: ImportInfo[] = [];
  let chunkIndex = 0;

  function processNode(node: any): void {
    // Collect imports
    if (langSupport.importNodeTypes.includes(node.type)) {
      const imp = langSupport.extractImport(node);
      if (imp) fileImports.push(imp);
      return;
    }

    // Unwrap namespace-like nodes
    if (langSupport.unwrapNodeTypes.includes(node.type)) {
      // For namespace_declaration, children are in the "body" (declaration_list)
      // For file_scoped_namespace_declaration, children are direct named children
      if (node.type === "namespace_declaration") {
        const body = node.childForFieldName("body");
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (child) processNode(child);
          }
        }
      } else {
        // file_scoped_namespace_declaration — skip the qualified_name, process the rest
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child && child.type !== "qualified_name") {
            processNode(child);
          }
        }
      }
      return;
    }

    const meta = langSupport.extractMetadata(node, lines);
    if (!meta) return;

    // Attach file imports to the first chunk
    if (chunkIndex === 0 && fileImports.length > 0) {
      meta.imports = fileImports;
    }

    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const body = lines.slice(node.startPosition.row, node.endPosition.row + 1).join("\n");
    const hash = new Bun.CryptoHasher("md5").update(body).digest("hex");

    chunks.push({
      filePath,
      chunkIndex,
      startLine,
      endLine,
      hash,
      body,
      metadata: toYaml(meta as unknown as Record<string, unknown>),
    });
    chunkIndex++;
  }

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (node) processNode(node);
  }

  return chunks;
}
```

**Step 2: Verify it compiles**

```bash
bun build src/parser.ts --no-bundle 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add src/parser.ts
git commit -m "refactor: parser.ts as language-agnostic dispatcher"
```

---

### Task 5: Add Config File Support

**Files:**
- Create: `src/config.ts`

**Step 1: Write the config module**

```typescript
// src/config.ts
import { resolve } from "path";

export interface ChunkrConfig {
  lang: string;
}

const CONFIG_FILENAME = ".chunkr.json";
const DEFAULT_LANG = "typescript";

/** Read .chunkr.json from the project root. Returns null if not found. */
export function readConfig(rootDir: string): ChunkrConfig | null {
  const configPath = resolve(rootDir, CONFIG_FILENAME);
  const file = Bun.file(configPath);
  // Bun.file doesn't throw on missing files — check size
  try {
    const text = require("fs").readFileSync(configPath, "utf-8");
    return JSON.parse(text) as ChunkrConfig;
  } catch {
    return null;
  }
}

/** Write .chunkr.json to the project root. */
export function writeConfig(rootDir: string, config: ChunkrConfig): void {
  const configPath = resolve(rootDir, CONFIG_FILENAME);
  require("fs").writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** Get the language for a project, falling back to default. */
export function getProjectLang(rootDir: string): string {
  const config = readConfig(rootDir);
  return config?.lang ?? DEFAULT_LANG;
}
```

**Step 2: Commit**

```bash
git add src/config.ts
git commit -m "feat: add .chunkr.json config file support"
```

---

### Task 6: Update indexer.ts to Use Config

**Files:**
- Modify: `src/indexer.ts`

**Step 1: Update imports and scanAllFiles**

Changes needed:
1. Import `getProjectLang` from config
2. Change `parseFile` calls to pass `langName`
3. Change `isSupported` calls to pass `langName`
4. Replace hardcoded glob `**/*.{ts,tsx,js,jsx}` with extensions from the language registry
5. Add `obj/`, `bin/` to the skip list

Key changes to `indexer.ts`:

```typescript
// At top of file, update imports:
import { parseFile, isSupported, getSupportedExtensions } from "./parser.ts";
import { getProjectLang } from "./config.ts";

// In scanAllFiles, replace the hardcoded glob:
async function scanAllFiles(rootDir: string, langName: string): Promise<string[]> {
  const extensions = getSupportedExtensions(langName);
  const globPattern = `**/*.{${extensions.map(e => e.slice(1)).join(",")}}`;
  const glob = new Bun.Glob(globPattern);
  const files: string[] = [];
  for await (const path of glob.scan({ cwd: rootDir, absolute: false, onlyFiles: true })) {
    if (
      path.startsWith("node_modules/") ||
      path.startsWith(".git/") ||
      path.startsWith(".claude/") ||
      path.startsWith("dist/") ||
      path.startsWith("out/") ||
      path.startsWith("obj/") ||
      path.startsWith("bin/") ||
      path.startsWith(".worktrees/") ||
      path.includes("/node_modules/") ||
      path.includes("/obj/") ||
      path.includes("/bin/")
    ) {
      continue;
    }
    files.push(path);
  }
  return files;
}

// In indexProject, add langName:
export async function indexProject(rootDir: string, dbPath?: string): Promise<IndexResult> {
  const resolvedRoot = resolve(rootDir);
  const langName = getProjectLang(resolvedRoot);
  // ... existing code ...
  // Change: filesToIndex = [...allChanged].filter((f) => isSupported(langName, f));
  // Change: filesToIndex = await scanAllFiles(resolvedRoot, langName);
  // Change: const newChunks = await parseFile(langName, filePath, source);
}

// In getStatus, add langName:
export async function getStatus(rootDir: string, dbPath?: string) {
  const resolvedRoot = resolve(rootDir);
  const langName = getProjectLang(resolvedRoot);
  // ... existing code ...
  // Change: changedFiles = [...].filter((f) => isSupported(langName, f));
}
```

**Step 2: Verify it compiles**

```bash
bun build src/indexer.ts --no-bundle 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add src/indexer.ts
git commit -m "refactor: indexer uses config for language selection"
```

---

### Task 7: Update cli.ts — init with --lang and agent command

**Files:**
- Modify: `src/cli.ts`

**Step 1: Update the init command to accept --lang**

```typescript
// In cli.ts, update the init case:
import { writeConfig, getProjectLang } from "./config.ts";
import { getAvailableLanguages } from "./languages/registry.ts";
// Ensure languages are registered:
import "./languages/typescript.ts";
import "./languages/csharp.ts";

// Parse --lang from args for init command:
case "init": {
  // Parse --lang flag
  let lang = "typescript";
  const langIdx = args.indexOf("--lang");
  if (langIdx !== -1 && args[langIdx + 1]) {
    lang = args[langIdx + 1];
  }
  // Validate language
  const available = getAvailableLanguages();
  if (!available.includes(lang)) {
    console.error(`Unknown language: "${lang}". Available: ${available.join(", ")}`);
    process.exit(1);
  }
  const db = initDb(dbPath);
  db.close();
  writeConfig(root, { lang });
  console.log(`Created ${dbPath}`);
  console.log(`Language: ${lang} (saved to .chunkr.json)`);
  break;
}
```

**Step 2: Add the agent command**

```typescript
case "agent": {
  const config = readConfig(root);
  const lang = config?.lang ?? "typescript";
  const extensions = getSupportedExtensions(lang).join(", ");

  let summary = { fileCount: 0, chunkCount: 0 };
  try {
    const db = openDb(dbPath);
    const s = getProjectSummary(db);
    summary = { fileCount: s.fileCount, chunkCount: s.chunkCount };
    db.close();
  } catch {
    // DB might not exist yet
  }

  console.log(`# chunkr — Code Index

This project is indexed with chunkr. Language: **${lang}** (${extensions} files).

## Commands
- \`chunkr query <file>\` — Show YAML metadata for all chunks in a file (no bodies)
- \`chunkr chunk <file> <line>\` — Get a specific chunk's source code + metadata
- \`chunkr summary\` — Project overview (file count, chunk count)
- \`chunkr status\` — Files changed since last index
- \`chunkr index\` — Re-index changed files

## Workflow
1. Use \`chunkr summary\` to understand project scope
2. Use \`chunkr query <file>\` to see what's in a file without reading it
3. Use \`chunkr chunk <file> <line>\` to retrieve only the code you need
4. After modifying files, run \`chunkr index\` to update the index

Indexed: ${summary.fileCount} files, ${summary.chunkCount} chunks.`);
  break;
}
```

**Step 3: Update usage text**

Add `agent` to the usage help string:

```
  agent             Output markdown guide for LLM consumption
```

**Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat: init --lang flag and agent command"
```

---

### Task 8: Update index.ts Re-exports

**Files:**
- Modify: `index.ts`

**Step 1: Add new exports**

```typescript
// Add to index.ts:
export { readConfig, writeConfig, getProjectLang } from "./src/config.ts";
export { getLanguageSupport, getAvailableLanguages } from "./src/languages/registry.ts";
export type { LanguageSupport } from "./src/languages/registry.ts";
```

Also update existing `parseFile` and `isSupported` exports since their signatures changed (now require `langName`).

**Step 2: Commit**

```bash
git add index.ts
git commit -m "feat: update re-exports for config and language registry"
```

---

### Task 9: End-to-End Test with C# Files

**Files:**
- Test in: the current Drongo project directory (`/home/timm/Source/Drongo`)

**Step 1: Delete existing .chunkr.db (from the earlier failed attempt)**

```bash
cd /home/timm/Source/Drongo
rm -f .chunkr.db
```

**Step 2: Init with C# language**

```bash
chunkr init --lang csharp
```

Expected output:
```
Created /home/timm/Source/Drongo/.chunkr.db
Language: csharp (saved to .chunkr.json)
```

Verify `.chunkr.json` exists:
```bash
cat .chunkr.json
```
Expected: `{ "lang": "csharp" }`

**Step 3: Index the project**

```bash
chunkr index
```

Expected: Should index `.cs` files (not `.ts`), skipping `obj/` and `bin/` directories.

**Step 4: Verify with query**

```bash
chunkr summary
chunkr query src/Drongo.Core/Messages/SipRequest.cs
```

Expected: Should show YAML metadata with class name, methods, properties.

**Step 5: Verify agent command**

```bash
chunkr agent
```

Expected: Markdown output showing language=csharp, file count, chunk count.

**Step 6: Verify chunk retrieval**

```bash
chunkr chunk src/Drongo.Core/Messages/SipRequest.cs 1
```

Expected: Body + metadata for the first chunk.

---

### Task 10: Test Backward Compatibility with TypeScript

**Step 1: Test in the chunkr project itself**

```bash
cd /home/timm/Source/tree-sitter-example
rm -f .chunkr.db .chunkr.json
chunkr init
chunkr index
chunkr summary
```

Expected: Should default to `typescript`, index `.ts` files, and work as before.

**Step 2: Commit any test fixture files if added**

```bash
git add -A
git commit -m "test: verify backward compatibility with TypeScript default"
```

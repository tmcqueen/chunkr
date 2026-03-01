# chunkr — Agent Skills

## What is chunkr?

chunkr is a semantic code index. It parses source files into chunks (classes, functions, interfaces, enums) and stores them in a local SQLite database. Use it to read code efficiently — browse metadata first, then retrieve only the chunks you need.

## When to use chunkr

- **Before reading a file** — run `chunkr query <file>` to see what's in it without consuming tokens on the full source
- **When exploring a codebase** — run `chunkr summary` to understand scope, then drill into specific files
- **After modifying files** — run `chunkr index` to update the index
- **When you need one function/class** — run `chunkr chunk <file> <line>` instead of reading the whole file

## Setup

If a project has a `.chunkr.json` file, it's already configured. Just run:

```bash
chunkr index
```

If not, initialize first:

```bash
chunkr init --lang csharp   # or: typescript (default)
chunkr index
```

## Commands

### `chunkr summary`

Start here. Shows file count, chunk count, and language breakdown.

### `chunkr query <file>`

Shows YAML metadata for every chunk in a file — name, type, params, returns, children, line ranges. No source bodies. Use this to decide which chunks to retrieve.

The `<file>` argument is a relative path from the project root (e.g. `src/Foo/Bar.cs`).

### `chunkr chunk <file> <start_line>`

Retrieves a single chunk's full source body and metadata. The second argument is the chunk's start line (from `query` output) or its zero-based chunk index.

### `chunkr status`

Shows files changed since the last index. Run this to decide whether to re-index.

### `chunkr index`

Re-indexes changed files. Incremental — only re-parses files modified since last run. Safe to run frequently.

### `chunkr describe <file> <chunk_index>`

Pipe a description into stdin to annotate a chunk. Descriptions survive re-indexing as long as the chunk body doesn't change.

```bash
echo "Handles SIP INVITE routing" | chunkr describe src/Router.cs 0
```

## Recommended workflow

```
1. chunkr summary              → understand project scope
2. chunkr query <file>         → browse a file's structure
3. chunkr chunk <file> <line>  → read only what you need
4. (make changes)
5. chunkr index                → update after edits
```

## Tips

- Prefer `chunkr query` over reading files directly — it's faster and uses fewer tokens
- The `line_range` field in metadata tells you exactly where each chunk lives
- The `children` field lists methods/properties inside a class without retrieving the full body
- Use `chunkr describe` to leave notes for future sessions — they persist across re-indexes
- If `chunkr query` returns "No chunks found", the file may not be indexed yet — run `chunkr index`

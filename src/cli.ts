#!/usr/bin/env bun
import { resolve } from "path";
import { findProjectRoot, indexProject, getStatus } from "./indexer.ts";
import {
  initDb,
  openDb,
  getChunksForFile,
  getChunk,
  getChunkByIndex,
  getFiles,
  getProjectSummary,
  updateChunkMetadata,
} from "./db.ts";
import { writeConfig, readConfig } from "./config.ts";
import { getAvailableLanguages } from "./languages/registry.ts";
import { getSupportedExtensions } from "./parser.ts";

function parseImportsFromMetadata(metadata: string): { name: string; from: string }[] {
  const imports: { name: string; from: string }[] = [];
  // Split into individual import entries
  const entries = metadata.split(/^  - name: /m);
  entries.shift(); // discard text before first entry
  for (const entry of entries) {
    const fromMatch = entry.match(/^\s*from: (.+)$/m);
    if (!fromMatch) continue;
    const from = fromMatch[1].trim();
    // Extract name: everything before the "from:" line
    const nameRaw = entry.slice(0, entry.indexOf(fromMatch[0]));
    // Handle multiline (starts with |) or quoted single-line
    let name: string;
    if (nameRaw.trimStart().startsWith("|")) {
      // Multiline block: collect indented lines after the |
      name = nameRaw.replace(/^\|?\s*\n?/, "").replace(/\n\s*/g, " ").trim();
    } else {
      // Single-line: strip surrounding quotes
      name = nameRaw.trim().replace(/^["']|["']$/g, "").trim();
    }
    imports.push({ name, from });
  }
  return imports;
}

function findImports(chunks: { metadata: string }[]): { name: string; from: string }[] {
  for (const c of chunks) {
    const imports = parseImportsFromMetadata(c.metadata);
    if (imports.length > 0) return imports;
  }
  return [];
}

function formatImports(imports: { name: string; from: string }[]): string[] {
  const lines: string[] = [];
  for (const imp of imports) {
    // Strip braces and clean up names
    const names = imp.name.replace(/[{}]/g, "").split(",").map(s => s.trim()).filter(Boolean);
    lines.push(`  ${imp.from}: ${names.join(", ")}`);
  }
  return lines;
}

const args = Bun.argv.slice(2);
const command = args[0];

function usage() {
  console.log(`chunkr — Tree-sitter code chunking tool

Commands:
  init [--lang <name>]  Create .chunkr.db and .chunkr.json (default: typescript)
  index [path]          Index files (full scan or incremental via git diff)
  status                Show files changed since last index
  files [path] [--ext .ts]  List indexed files with chunk counts
  imports <file>        Show import dependencies for a file
  query <file>          Show all chunk metadata (YAML) for a file
  chunk <file> <n>      Show chunk body (n = start line or chunk index)
  summary               Project overview: file count, languages, chunks
  describe <file> <idx> Update a chunk's description (reads from stdin)
  agent                 Output markdown guide for LLM consumption

Languages: ${getAvailableLanguages().join(", ")}`);
}

async function main() {
  if (!command || command === "--help" || command === "-h") {
    usage();
    process.exit(0);
  }

  const root = findProjectRoot();
  const dbPath = resolve(root, ".chunkr.db");

  switch (command) {
    case "init": {
      let lang = "typescript";
      const langIdx = args.indexOf("--lang");
      if (langIdx !== -1 && args[langIdx + 1]) {
        lang = args[langIdx + 1];
      }
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

    case "index": {
      const targetPath = args[1] ? resolve(args[1]) : root;
      const result = await indexProject(targetPath, dbPath);
      console.log(
        `Indexed ${result.filesIndexed} files, ${result.chunksCreated} new chunks, ${result.chunksUnchanged} unchanged`
      );
      if (result.filesSkipped > 0)
        console.log(`Skipped ${result.filesSkipped} unchanged files`);
      if (result.filesDeleted > 0)
        console.log(`Removed ${result.filesDeleted} deleted files`);
      break;
    }

    case "status": {
      const status = await getStatus(root, dbPath);
      if (!status.isInitialized) {
        console.log("Not initialized. Run: chunkr init");
        break;
      }
      if (status.changedFiles.length === 0) {
        console.log("No changes since last index.");
      } else {
        console.log(
          `${status.changedFiles.length} file(s) changed since last index:`
        );
        for (const f of status.changedFiles) {
          console.log(`  ${f}`);
        }
      }
      break;
    }

    case "files": {
      const db = openDb(dbPath);
      let pathPrefix: string | undefined;
      let ext: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--ext" && args[i + 1]) {
          ext = args[++i];
        } else if (!pathPrefix) {
          pathPrefix = args[i];
        }
      }
      const files = getFiles(db, { extension: ext, pathPrefix });
      for (const f of files) {
        console.log(`${f.path} (${f.chunkCount} chunks)`);
      }
      db.close();
      break;
    }

    case "imports": {
      const filePath = args[1];
      if (!filePath) {
        console.error("Usage: chunkr imports <file>");
        process.exit(1);
      }
      const db = openDb(dbPath);
      const relPath = filePath.startsWith("/")
        ? filePath.slice(root.length + 1)
        : filePath;
      const chunks = getChunksForFile(db, relPath);
      if (chunks.length === 0) {
        console.log(`No chunks found for ${relPath}`);
      } else {
        const imports = findImports(chunks);
        if (imports.length === 0) {
          console.log(`No imports found in ${relPath}`);
        } else {
          console.log(`${relPath} imports:`);
          for (const line of formatImports(imports)) {
            console.log(line);
          }
        }
      }
      db.close();
      break;
    }

    case "query": {
      const filePath = args[1];
      if (!filePath) {
        console.error("Usage: chunkr query <file>");
        process.exit(1);
      }
      const db = openDb(dbPath);
      const relPath = filePath.startsWith("/")
        ? filePath.slice(root.length + 1)
        : filePath;
      const chunks = getChunksForFile(db, relPath);
      if (chunks.length === 0) {
        console.log(`No chunks found for ${relPath}`);
      } else {
        const imports = findImports(chunks);
        if (imports.length > 0) {
          console.log("=== imports ===");
          for (const line of formatImports(imports)) {
            console.log(line);
          }
        }
        console.log("=== chunks ===");
        for (const c of chunks) {
          console.log(`--- chunk ${c.chunkIndex} (lines ${c.startLine}-${c.endLine}) ---`);
          console.log(c.metadata);
        }
      }
      db.close();
      break;
    }

    case "chunk": {
      const filePath = args[1];
      const lineOrIndex = parseInt(args[2], 10);
      if (!filePath || isNaN(lineOrIndex)) {
        console.error("Usage: chunkr chunk <file> <start_line|chunk_index>");
        process.exit(1);
      }
      const db = openDb(dbPath);
      const relPath = filePath.startsWith("/")
        ? filePath.slice(root.length + 1)
        : filePath;
      // Try by start_line first, then by chunk_index
      let chunk = getChunk(db, relPath, lineOrIndex);
      if (!chunk) chunk = getChunkByIndex(db, relPath, lineOrIndex);
      if (!chunk) {
        console.error(`No chunk found at ${relPath}:${lineOrIndex}`);
        process.exit(1);
      }
      console.log(`--- body (lines ${chunk.startLine}-${chunk.endLine}) ---`);
      console.log(chunk.body);
      db.close();
      break;
    }

    case "summary": {
      const db = openDb(dbPath);
      const summary = getProjectSummary(db);
      console.log(`Files: ${summary.fileCount}`);
      console.log(`Chunks: ${summary.chunkCount}`);
      console.log("Languages:");
      for (const [ext, count] of Object.entries(summary.languages)) {
        console.log(`  .${ext}: ${count} files`);
      }
      db.close();
      break;
    }

    case "describe": {
      const filePath = args[1];
      const chunkIndex = parseInt(args[2], 10);
      if (!filePath || isNaN(chunkIndex)) {
        console.error("Usage: chunkr describe <file> <chunk_index>");
        console.error("Reads description from stdin.");
        process.exit(1);
      }
      const db = openDb(dbPath);
      const relPath = filePath.startsWith("/")
        ? filePath.slice(root.length + 1)
        : filePath;
      const chunk = getChunkByIndex(db, relPath, chunkIndex);
      if (!chunk) {
        console.error(`No chunk found: ${relPath} index ${chunkIndex}`);
        process.exit(1);
      }
      // Read description from stdin
      const description = await Bun.stdin.text();
      // Update the YAML metadata — append/replace the description field
      let metadata = chunk.metadata;
      if (metadata.includes("description:")) {
        metadata = metadata.replace(
          /description:.*(\n|$)/,
          `description: ${description.trim()}\n`
        );
      } else {
        metadata += `description: ${description.trim()}\n`;
      }
      updateChunkMetadata(db, chunk.id!, metadata);
      console.log(`Updated description for ${relPath} chunk ${chunkIndex}`);
      db.close();
      break;
    }

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
- \`chunkr files [path] [--ext .ts]\` — List indexed files with chunk counts, optionally filtered
- \`chunkr imports <file>\` — Show import dependencies for a file
- \`chunkr query <file>\` — Show YAML metadata for all chunks in a file (imports highlighted at top)
- \`chunkr chunk <file> <line>\` — Get a specific chunk's source code
- \`chunkr summary\` — Project overview (file count, chunk count)
- \`chunkr status\` — Files changed since last index
- \`chunkr index\` — Re-index changed files

## Workflow
1. Use \`chunkr summary\` to understand project scope
2. Use \`chunkr files [--ext .ts]\` to discover files, filter by extension or path
3. Use \`chunkr imports <file>\` to see what a file depends on
4. Use \`chunkr query <file>\` to see what's in a file without reading it
5. Use \`chunkr chunk <file> <line>\` to retrieve only the code you need
6. After modifying files, run \`chunkr index\` to update the index

Indexed: ${summary.fileCount} files, ${summary.chunkCount} chunks.`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

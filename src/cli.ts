#!/usr/bin/env bun
import { resolve } from "path";
import { findProjectRoot, indexProject, getStatus } from "./indexer.ts";
import {
  initDb,
  openDb,
  getChunksForFile,
  getChunk,
  getChunkByIndex,
  getProjectSummary,
  updateChunkMetadata,
} from "./db.ts";

const args = Bun.argv.slice(2);
const command = args[0];

function usage() {
  console.log(`chunkr — Tree-sitter code chunking tool

Commands:
  init              Create .chunkr.db with schema
  index [path]      Index files (full scan or incremental via git diff)
  status            Show files changed since last index
  query <file>      Show all chunk metadata (YAML) for a file
  chunk <file> <n>  Show chunk body + metadata (n = start line or chunk index)
  summary           Project overview: file count, languages, chunks
  describe <file> <chunk_index>
                    Update a chunk's description (reads from stdin)`);
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
      const db = initDb(dbPath);
      db.close();
      console.log(`Created ${dbPath}`);
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
      console.log(`--- metadata ---`);
      console.log(chunk.metadata);
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

#!/usr/bin/env bun
/**
 * Benchmark: Naive file reading vs chunkr exploration on flow-forge
 *
 * "Normal way" = reading all source files (what an agent does with cat/Read)
 * "chunkr way" = summary → files → query → selective chunk reads
 */

import { join, resolve } from "path";
import { Database } from "bun:sqlite";

const FLOW_FORGE = "/home/timm/Source/flow-forge";
const CHUNKR = resolve("/home/timm/Source/chunkr/src/cli.ts");
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

const SKIP_DIRS = ["node_modules/", ".git/", "dist/", "out/", "obj/", "bin/", ".worktrees/", ".claude/"];

const TEST_PATH_PATTERNS = [
  /(?:^|\/)tests?\//i,
  /(?:^|\/)__tests__\//,
  /(?:^|\/)__snapshots__\//,
  /(?:^|\/)fixtures?\//i,
  /\.(?:test|spec)\./i,
];

function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERNS.some((re) => re.test(path));
}

// ---------------------------------------------------------------------------
// Naive approach: read all source files
// ---------------------------------------------------------------------------

async function measureNaive(): Promise<{ files: number; loc: number; bytes: number }> {
  const glob = new Bun.Glob("**/*");
  let loc = 0, bytes = 0, files = 0;

  for await (const path of glob.scan({ cwd: FLOW_FORGE, onlyFiles: true, dot: false })) {
    if (SKIP_DIRS.some(d => path.includes(d))) continue;
    if (!EXTENSIONS.some(ext => path.endsWith(ext))) continue;

    const file = Bun.file(join(FLOW_FORGE, path));
    bytes += file.size;
    const content = await file.text();
    loc += content.split("\n").length;
    files++;
  }

  return { files, loc, bytes };
}

// ---------------------------------------------------------------------------
// chunkr approach: simulated exploration from DB
// ---------------------------------------------------------------------------

interface ChunkRow {
  file_path: string;
  chunk_index: number;
  start_line: number;
  end_line: number;
  metadata: string;
  body: string;
}

function isExportedOrPublic(metadata: string): boolean {
  if (/exports:\s*true/m.test(metadata)) return true;
  if (/type:\s*(class|interface|enum|record|struct)/m.test(metadata)) return true;
  return false;
}

const ARCHITECTURAL_STEMS = new Set([
  "index", "types", "main", "mod", "lib", "config", "app", "schema", "core", "base", "utils",
]);

function chunkPriority(metadata: string): number {
  if (/type:\s*(class|interface|struct|enum|record)/m.test(metadata)) return 0;
  if (/type:\s*(function|method)/m.test(metadata) && /children:/m.test(metadata)) return 1;
  return 2;
}

function simulateChunkr(
  dbPath: string,
  opts?: { chunkBudget?: number; fileBudget?: number }
): {
  totalBytes: number;
  filesQueried: number;
  totalFiles: number;
  chunksRead: number;
  breakdown: { summary: number; files: number; query: number; chunks: number };
} {
  const db = new Database(dbPath);
  let summaryBytes = 0, filesBytes = 0, queryBytes = 0, chunkBytes = 0;

  // 1. Summary
  const fileCount = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM files").get()?.c ?? 0;
  const chunkCount = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM chunks").get()?.c ?? 0;
  const filePaths = db.query<{ path: string }, []>("SELECT path FROM files ORDER BY path").all();

  const languages: Record<string, number> = {};
  for (const f of filePaths) {
    const ext = f.path.split(".").pop() ?? "unknown";
    languages[ext] = (languages[ext] ?? 0) + 1;
  }
  let summaryText = `Files: ${fileCount}\nChunks: ${chunkCount}\nLanguages:\n`;
  for (const [ext, count] of Object.entries(languages)) {
    summaryText += `  .${ext}: ${count} files\n`;
  }
  summaryBytes = Buffer.byteLength(summaryText, "utf-8");

  // 2. Files listing
  const fileChunkCounts = db.query<{ path: string; cnt: number }, []>(
    `SELECT f.path, COUNT(c.id) as cnt FROM files f
     LEFT JOIN chunks c ON c.file_path = f.path
     GROUP BY f.path ORDER BY f.path`
  ).all();

  const filteredFiles: string[] = [];
  for (const f of fileChunkCounts) {
    const line = `${f.path} (${f.cnt} chunks)\n`;
    filesBytes += Buffer.byteLength(line, "utf-8");
    if (!isTestPath(f.path)) filteredFiles.push(f.path);
  }

  // 3. Query metadata for files
  const allChunks = db.query<ChunkRow, []>(
    `SELECT file_path, chunk_index, start_line, end_line, metadata, body
     FROM chunks ORDER BY file_path, chunk_index`
  ).all();

  const chunksByFile = new Map<string, ChunkRow[]>();
  for (const c of allChunks) {
    let arr = chunksByFile.get(c.file_path);
    if (!arr) { arr = []; chunksByFile.set(c.file_path, arr); }
    arr.push(c);
  }

  // Apply file budget
  let queriedFiles = filteredFiles;
  if (opts?.fileBudget != null) {
    // Prioritize architectural files, round-robin across dirs
    const byDir = new Map<string, string[]>();
    for (const f of filteredFiles) {
      const dir = f.substring(0, f.lastIndexOf("/")) || ".";
      let arr = byDir.get(dir);
      if (!arr) { arr = []; byDir.set(dir, arr); }
      arr.push(f);
    }
    for (const [, bucket] of byDir) {
      bucket.sort((a, b) => {
        const stemA = a.split("/").pop()?.split(".")[0] ?? "";
        const stemB = b.split("/").pop()?.split(".")[0] ?? "";
        const prioA = ARCHITECTURAL_STEMS.has(stemA) ? 0 : 1;
        const prioB = ARCHITECTURAL_STEMS.has(stemB) ? 0 : 1;
        return prioA !== prioB ? prioA - prioB : a.localeCompare(b);
      });
    }
    const dirKeys = [...byDir.keys()].sort();
    const cursors = new Map(dirKeys.map(k => [k, 0]));
    const selected: string[] = [];
    while (selected.length < opts.fileBudget) {
      let anyPicked = false;
      for (const dir of dirKeys) {
        if (selected.length >= opts.fileBudget) break;
        const bucket = byDir.get(dir)!;
        const cursor = cursors.get(dir)!;
        if (cursor < bucket.length) {
          selected.push(bucket[cursor]);
          cursors.set(dir, cursor + 1);
          anyPicked = true;
        }
      }
      if (!anyPicked) break;
    }
    queriedFiles = selected;
  }

  const filteredSet = new Set(queriedFiles);
  const exportedByFile = new Map<string, ChunkRow[]>();

  for (const [filePath, chunks] of chunksByFile) {
    if (!filteredSet.has(filePath)) continue;
    for (const c of chunks) {
      const queryLine = `--- chunk ${c.chunk_index} (lines ${c.start_line}-${c.end_line}) ---\n${c.metadata}\n`;
      queryBytes += Buffer.byteLength(queryLine, "utf-8");
    }
    const exported = chunks.filter(c => isExportedOrPublic(c.metadata));
    if (exported.length > 0) exportedByFile.set(filePath, exported);
  }

  // 4. Read chunk bodies
  let selectedChunks: Set<ChunkRow>;
  if (opts?.chunkBudget != null) {
    // Round-robin with priority
    const selected = new Set<ChunkRow>();
    for (const [, chunks] of exportedByFile) {
      chunks.sort((a, b) => chunkPriority(a.metadata) - chunkPriority(b.metadata));
    }
    const fileKeys = [...exportedByFile.keys()];
    const cursors = new Map(fileKeys.map(k => [k, 0]));
    let remaining = opts.chunkBudget;
    while (remaining > 0) {
      let anyPicked = false;
      for (const key of fileKeys) {
        if (remaining <= 0) break;
        const bucket = exportedByFile.get(key)!;
        const cursor = cursors.get(key)!;
        if (cursor < bucket.length) {
          selected.add(bucket[cursor]);
          cursors.set(key, cursor + 1);
          remaining--;
          anyPicked = true;
        }
      }
      if (!anyPicked) break;
    }
    selectedChunks = selected;
  } else {
    selectedChunks = new Set<ChunkRow>();
    for (const chunks of exportedByFile.values()) {
      for (const c of chunks) selectedChunks.add(c);
    }
  }

  let chunksRead = 0;
  for (const c of selectedChunks) {
    const chunkOutput = `--- body (lines ${c.start_line}-${c.end_line}) ---\n${c.body}\n`;
    chunkBytes += Buffer.byteLength(chunkOutput, "utf-8");
    chunksRead++;
  }

  db.close();

  return {
    totalBytes: summaryBytes + filesBytes + queryBytes + chunkBytes,
    filesQueried: queriedFiles.length,
    totalFiles: filePaths.length,
    chunksRead,
    breakdown: { summary: summaryBytes, files: filesBytes, query: queryBytes, chunks: chunkBytes },
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  const fmt = (n: number) => n.toLocaleString();
  const tokens = (bytes: number) => Math.round(bytes / 4);

  console.log("=== flow-forge: Naive vs chunkr Token Benchmark ===\n");

  // --- Naive ---
  console.log("1. NAIVE APPROACH (read all source files)");
  const naive = await measureNaive();
  const naiveTokens = tokens(naive.bytes);
  console.log(`   Files: ${fmt(naive.files)}`);
  console.log(`   LOC:   ${fmt(naive.loc)}`);
  console.log(`   Bytes: ${fmt(naive.bytes)}`);
  console.log(`   Est. tokens: ${fmt(naiveTokens)}`);

  // --- chunkr: index ---
  console.log("\n2. CHUNKR APPROACH");
  const dbPath = join(FLOW_FORGE, ".chunkr.db");

  // Ensure indexed
  const initProc = Bun.spawn(["bun", CHUNKR, "init"], { cwd: FLOW_FORGE, stdout: "pipe", stderr: "pipe" });
  await initProc.exited;
  const idxProc = Bun.spawn(["bun", CHUNKR, "index"], { cwd: FLOW_FORGE, stdout: "pipe", stderr: "pipe" });
  const idxOut = await new Response(idxProc.stdout).text();
  await idxProc.exited;
  console.log(`   Index: ${idxOut.trim()}`);

  // Exploration levels
  const levels = [
    { label: "Full (all metadata + all exports)", opts: {} },
    { label: "Budget 50 chunks", opts: { chunkBudget: 50 } },
    { label: "Budget 10 chunks", opts: { chunkBudget: 10 } },
    { label: "Targeted (10 files, 10 chunks)", opts: { chunkBudget: 10, fileBudget: 10 } },
  ];

  console.log("\n   Level                              │ Tokens     │ % of Naive │ Files │ Chunks");
  console.log("   ───────────────────────────────────┼────────────┼────────────┼───────┼───────");

  for (const { label, opts } of levels) {
    const result = simulateChunkr(dbPath, opts);
    const t = tokens(result.totalBytes);
    const pct = ((t / naiveTokens) * 100).toFixed(1);
    console.log(
      `   ${label.padEnd(37)}│ ${fmt(t).padStart(10)} │ ${(pct + "%").padStart(10)} │ ${String(result.filesQueried).padStart(5)} │ ${String(result.chunksRead).padStart(5)}`
    );
  }

  // Breakdown for "Full" level
  const full = simulateChunkr(dbPath);
  console.log("\n   Token breakdown (Full level):");
  console.log(`     summary:  ${fmt(tokens(full.breakdown.summary))}`);
  console.log(`     files:    ${fmt(tokens(full.breakdown.files))}`);
  console.log(`     query:    ${fmt(tokens(full.breakdown.query))}`);
  console.log(`     chunks:   ${fmt(tokens(full.breakdown.chunks))}`);

  // Savings
  const fullTokens = tokens(full.totalBytes);
  console.log(`\n   === SAVINGS ===`);
  console.log(`   Naive (read everything):   ${fmt(naiveTokens)} tokens`);
  console.log(`   chunkr (full exploration): ${fmt(fullTokens)} tokens`);
  console.log(`   Reduction:                 ${((1 - fullTokens / naiveTokens) * 100).toFixed(1)}%`);
  console.log(`   Ratio:                     ${(naiveTokens / fullTokens).toFixed(1)}x fewer tokens`);

  // Cleanup
  const { rm } = require("node:fs/promises");
  await rm(join(FLOW_FORGE, ".chunkr.db"), { force: true });
  await rm(join(FLOW_FORGE, ".chunkr.json"), { force: true });
}

main();

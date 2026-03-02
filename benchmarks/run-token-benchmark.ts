#!/usr/bin/env bun
/**
 * Token Scaling Benchmark for chunkr
 *
 * Measures how many tokens chunkr's chunked navigation uses vs.
 * naive full-file reading across 9 repos (3 sizes × 3 languages).
 *
 * Output: benchmarks/token-scaling.csv
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Repo definitions
// ---------------------------------------------------------------------------

interface RepoConfig {
  language: string;
  langFlag: string;
  url: string;
  extensions: string[];
  indexPath?: string;
}

const REPOS: RepoConfig[] = [
  // JavaScript — Small / Medium / Large
  {
    language: "JavaScript",
    langFlag: "typescript",
    url: "https://github.com/expressjs/express.git",
    extensions: [".js", ".jsx", ".ts", ".tsx"],
  },
  {
    language: "JavaScript",
    langFlag: "typescript",
    url: "https://github.com/facebook/react.git",
    extensions: [".js", ".jsx", ".ts", ".tsx"],
  },
  {
    language: "JavaScript",
    langFlag: "typescript",
    url: "https://github.com/nicolo-ribaudo/babel.git",
    extensions: [".js", ".jsx", ".ts", ".tsx"],
  },
  // TypeScript — Small / Medium / Large
  {
    language: "TypeScript",
    langFlag: "typescript",
    url: "https://github.com/colinhacks/zod.git",
    extensions: [".ts", ".tsx"],
  },
  {
    language: "TypeScript",
    langFlag: "typescript",
    url: "https://github.com/microsoft/vscode.git",
    extensions: [".ts", ".tsx"],
    indexPath: "src/vs/editor",
  },
  {
    language: "TypeScript",
    langFlag: "typescript",
    url: "https://github.com/microsoft/TypeScript.git",
    extensions: [".ts", ".tsx"],
  },
  // C# — Small / Medium / Large
  {
    language: "C#",
    langFlag: "csharp",
    url: "https://github.com/serilog/serilog.git",
    extensions: [".cs"],
  },
  {
    language: "C#",
    langFlag: "csharp",
    url: "https://github.com/dotnet/efcore.git",
    extensions: [".cs"],
  },
  {
    language: "C#",
    langFlag: "csharp",
    url: "https://github.com/dotnet/runtime.git",
    extensions: [".cs"],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function run(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Command failed: ${cmd.join(" ")}\n${stderr}`);
  }
  return stdout;
}

async function chunkr(args: string[], cwd: string): Promise<string> {
  const chunkrBin = resolve(import.meta.dir, "../src/cli.ts");
  return run(["bun", chunkrBin, ...args], cwd);
}

/**
 * Measure LOC and bytes of all source files that chunkr would index.
 * Mirrors the indexer's skip list (node_modules, .git, dist, etc.)
 * but does NOT skip test directories — chunkr indexes those too.
 */
async function measureSource(
  dir: string,
  extensions: string[]
): Promise<{ loc: number; bytes: number }> {
  const glob = new Bun.Glob("**/*");
  let loc = 0;
  let bytes = 0;
  for await (const path of glob.scan({ cwd: dir, onlyFiles: true, dot: false })) {
    if (
      path.includes("node_modules/") ||
      path.includes(".git/") ||
      path.includes(".claude/") ||
      path.includes("dist/") ||
      path.includes("out/") ||
      path.includes("obj/") ||
      path.includes("bin/") ||
      path.includes(".worktrees/")
    )
      continue;
    if (!extensions.some((ext) => path.endsWith(ext))) continue;

    const file = Bun.file(join(dir, path));
    bytes += file.size;
    const content = await file.text();
    loc += content.split("\n").length;
  }
  return { loc, bytes };
}

// ---------------------------------------------------------------------------
// DB-based measurement (avoids spawning a process per file)
// ---------------------------------------------------------------------------

interface ChunkRow {
  file_path: string;
  chunk_index: number;
  start_line: number;
  end_line: number;
  metadata: string;
  body: string;
}

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

/**
 * Rank a chunk for selection priority.
 * Lower number = higher priority.
 *   0: classes, interfaces, structs (architectural understanding)
 *   1: functions/methods with children (complex implementations)
 *   2: everything else
 */
function chunkPriority(metadata: string): number {
  if (/type:\s*(class|interface|struct|enum|record)/m.test(metadata)) return 0;
  if (/type:\s*(function|method)/m.test(metadata) && /children:/m.test(metadata))
    return 1;
  return 2;
}

/**
 * Select up to `budget` chunks from per-file buckets using round-robin.
 * Within each file, chunks are sorted by priority (classes first, then
 * complex functions, then the rest). Round-robin ensures breadth across
 * files rather than exhausting one file before moving to the next.
 */
function selectChunksByBudget(
  perFileBuckets: Map<string, ChunkRow[]>,
  budget: number
): Set<ChunkRow> {
  const selected = new Set<ChunkRow>();

  // Sort each bucket by priority
  for (const [, chunks] of perFileBuckets) {
    chunks.sort((a, b) => chunkPriority(a.metadata) - chunkPriority(b.metadata));
  }

  // Round-robin across files
  const fileKeys = [...perFileBuckets.keys()];
  const cursors = new Map<string, number>(fileKeys.map((k) => [k, 0]));
  let remaining = budget;

  while (remaining > 0) {
    let anyPicked = false;
    for (const key of fileKeys) {
      if (remaining <= 0) break;
      const bucket = perFileBuckets.get(key)!;
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

  return selected;
}

const ARCHITECTURAL_STEMS = new Set([
  "index", "types", "main", "mod", "lib", "config", "app", "schema", "core", "base", "utils",
]);

/**
 * Select up to `fileBudget` files from the filtered list using round-robin
 * across parent directories. Files with architectural stem names (index,
 * types, main, etc.) are prioritized within each directory bucket.
 */
function selectFilesByBudget(files: string[], fileBudget: number): string[] {
  // Group by parent directory
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const lastSlash = f.lastIndexOf("/");
    const dir = lastSlash >= 0 ? f.substring(0, lastSlash) : ".";
    let arr = byDir.get(dir);
    if (!arr) {
      arr = [];
      byDir.set(dir, arr);
    }
    arr.push(f);
  }

  // Sort each bucket: architectural stems first (priority 0), then alphabetically
  for (const [, bucket] of byDir) {
    bucket.sort((a, b) => {
      const stemA = a.split("/").pop()?.split(".")[0] ?? "";
      const stemB = b.split("/").pop()?.split(".")[0] ?? "";
      const prioA = ARCHITECTURAL_STEMS.has(stemA) ? 0 : 1;
      const prioB = ARCHITECTURAL_STEMS.has(stemB) ? 0 : 1;
      if (prioA !== prioB) return prioA - prioB;
      return a.localeCompare(b);
    });
  }

  // Round-robin across directories
  const dirKeys = [...byDir.keys()].sort();
  const cursors = new Map<string, number>(dirKeys.map((k) => [k, 0]));
  const selected: string[] = [];

  while (selected.length < fileBudget) {
    let anyPicked = false;
    for (const dir of dirKeys) {
      if (selected.length >= fileBudget) break;
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

  return selected;
}

/**
 * Simulate the chunkr exploration workflow by reading directly from the DB.
 * This produces the same data as running CLI commands, but is orders of
 * magnitude faster for large repos.
 *
 * Workflow:
 *   1. summary — file count, chunk count, language breakdown
 *   2. files — list files with chunk counts, filter out test paths
 *   3. query filtered files — metadata only, no bodies
 *   4. chunk exported/public declarations — body only (no metadata)
 *
 * When `chunkBudget` is set, only that many exported chunk bodies are read,
 * selected via round-robin across files (prioritizing classes/interfaces,
 * then complex functions). This simulates an agent that reads metadata for
 * everything but only fetches bodies for a targeted subset.
 */
function simulateExploration(
  dbPath: string,
  chunkBudget?: number,
  fileBudget?: number
): {
  totalBytes: number;
  filesQueried: number;
  totalFiles: number;
  chunksRead: number;
} {
  const db = new Database(dbPath);

  let totalBytes = 0;

  // 1. Summary output (same as `chunkr summary`)
  const fileCount =
    db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM files").get()?.c ?? 0;
  const chunkCount =
    db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM chunks").get()?.c ?? 0;
  const filePaths = db
    .query<{ path: string }, []>("SELECT path FROM files ORDER BY path")
    .all();

  const languages: Record<string, number> = {};
  for (const f of filePaths) {
    const ext = f.path.split(".").pop() ?? "unknown";
    languages[ext] = (languages[ext] ?? 0) + 1;
  }

  let summaryText = `Files: ${fileCount}\nChunks: ${chunkCount}\nLanguages:\n`;
  for (const [ext, count] of Object.entries(languages)) {
    summaryText += `  .${ext}: ${count} files\n`;
  }
  totalBytes += Buffer.byteLength(summaryText, "utf-8");

  // 2. Files listing — simulate `chunkr files` output, filter out test paths
  const fileChunkCounts = db
    .query<{ path: string; cnt: number }, []>(
      `SELECT f.path, COUNT(c.id) as cnt FROM files f
       LEFT JOIN chunks c ON c.file_path = f.path
       GROUP BY f.path ORDER BY f.path`
    )
    .all();

  const filteredFiles: string[] = [];
  for (const f of fileChunkCounts) {
    const line = `${f.path} (${f.cnt} chunks)\n`;
    totalBytes += Buffer.byteLength(line, "utf-8");
    if (!isTestPath(f.path)) {
      filteredFiles.push(f.path);
    }
  }

  // 3. Query only filtered files — metadata headers (no bodies)
  const allChunks = db
    .query<ChunkRow, []>(
      `SELECT file_path, chunk_index, start_line, end_line, metadata, body
       FROM chunks ORDER BY file_path, chunk_index`
    )
    .all();

  // Group chunks by file
  const chunksByFile = new Map<string, ChunkRow[]>();
  for (const c of allChunks) {
    let arr = chunksByFile.get(c.file_path);
    if (!arr) {
      arr = [];
      chunksByFile.set(c.file_path, arr);
    }
    arr.push(c);
  }

  // When fileBudget is set, only query metadata for a subset of files
  const queriedFiles = fileBudget != null
    ? selectFilesByBudget(filteredFiles, fileBudget)
    : filteredFiles;
  const filteredSet = new Set(queriedFiles);

  // Collect all exported chunks across queried files (for budget selection)
  const exportedByFile = new Map<string, ChunkRow[]>();

  for (const [filePath, chunks] of chunksByFile) {
    if (!filteredSet.has(filePath)) continue;

    // Query output: metadata headers for all chunks (no bodies)
    for (const c of chunks) {
      const queryLine = `--- chunk ${c.chunk_index} (lines ${c.start_line}-${c.end_line}) ---\n${c.metadata}\n`;
      totalBytes += Buffer.byteLength(queryLine, "utf-8");
    }

    // Collect exported chunks for this file
    const exported = chunks.filter((c) => isExportedOrPublic(c.metadata));
    if (exported.length > 0) {
      exportedByFile.set(filePath, exported);
    }
  }

  // 4. Read chunk bodies — either all exports or a budgeted subset
  let selectedChunks: Set<ChunkRow>;
  if (chunkBudget != null) {
    selectedChunks = selectChunksByBudget(exportedByFile, chunkBudget);
  } else {
    // No budget — read all exported chunks
    selectedChunks = new Set<ChunkRow>();
    for (const chunks of exportedByFile.values()) {
      for (const c of chunks) selectedChunks.add(c);
    }
  }

  let chunksRead = 0;
  for (const c of selectedChunks) {
    const chunkOutput =
      `--- body (lines ${c.start_line}-${c.end_line}) ---\n${c.body}\n`;
    totalBytes += Buffer.byteLength(chunkOutput, "utf-8");
    chunksRead++;
  }

  db.close();

  return {
    totalBytes,
    filesQueried: queriedFiles.length,
    totalFiles: filePaths.length,
    chunksRead,
  };
}

/**
 * Determine if a chunk represents an exported/public declaration.
 * For JS/TS: exports: true in YAML metadata
 * For C#: type is class/interface/enum/record (top-level types are public API)
 */
function isExportedOrPublic(metadata: string): boolean {
  // JS/TS: explicit exports flag
  if (/exports:\s*true/m.test(metadata)) return true;
  // C#: top-level public types (classes, interfaces, enums, records, structs)
  if (/type:\s*(class|interface|enum|record|struct)/m.test(metadata)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Main benchmark
// ---------------------------------------------------------------------------

interface BenchmarkResult {
  language: string;
  url: string;
  commit: string;
  loc: number;
  naiveTokens: number;
  fullTokens: number;
  budget50Tokens: number;
  budget10Tokens: number;
  targetedTokens: number;
}

async function benchmarkRepo(repo: RepoConfig): Promise<BenchmarkResult> {
  const repoName = repo.url.split("/").pop()?.replace(".git", "") ?? "unknown";
  const tmpDir = await mkdtemp(join(tmpdir(), `chunkr-bench-${repoName}-`));

  try {
    // 1. Clone
    console.log(`  Cloning ${repo.url} ...`);
    await run(["git", "clone", "--depth", "1", repo.url, tmpDir], tmpdir());

    // 2. Record commit
    const commit = (
      await run(["git", "rev-parse", "--short", "HEAD"], tmpDir)
    ).trim();

    // 3. Determine source directory for LOC measurement
    const sourceDir = repo.indexPath ? join(tmpDir, repo.indexPath) : tmpDir;

    // 4. Count LOC + estimate tokens
    console.log(`  Measuring source files ...`);
    const { loc, bytes } = await measureSource(sourceDir, repo.extensions);
    const naiveTokens = Math.round(bytes / 4);
    console.log(
      `  LOC: ${loc.toLocaleString()}, Naive tokens: ${naiveTokens.toLocaleString()}`
    );

    // 5. Init chunkr
    await chunkr(["init", "--lang", repo.langFlag], tmpDir);

    // 6. Index
    console.log(`  Indexing ...`);
    const indexArgs = repo.indexPath ? ["index", repo.indexPath] : ["index"];
    const indexOutput = await chunkr(indexArgs, tmpDir);
    console.log(`  ${indexOutput.trim()}`);

    // 7. Simulate exploration at multiple budget levels
    const dbPath = join(tmpDir, ".chunkr.db");
    console.log(`  Simulating chunkr exploration ...`);

    const full = simulateExploration(dbPath);
    const b50 = simulateExploration(dbPath, 50);
    const b10 = simulateExploration(dbPath, 10);
    const targeted = simulateExploration(dbPath, 10, 10);

    const fullTokens = Math.round(full.totalBytes / 4);
    const budget50Tokens = Math.round(b50.totalBytes / 4);
    const budget10Tokens = Math.round(b10.totalBytes / 4);
    const targetedTokens = Math.round(targeted.totalBytes / 4);

    const pct = (n: number) => ((n / naiveTokens) * 100).toFixed(1);

    console.log(
      `  Files queried: ${full.filesQueried}/${full.totalFiles}, Exported chunks: ${full.chunksRead}`
    );
    console.log(`  Tokens:`);
    console.log(
      `    Naive:      ${naiveTokens.toLocaleString().padStart(10)}`
    );
    console.log(
      `    Full:       ${fullTokens.toLocaleString().padStart(10)} (${pct(fullTokens)}%)`
    );
    console.log(
      `    Budget 50:  ${budget50Tokens.toLocaleString().padStart(10)} (${pct(budget50Tokens)}%)`
    );
    console.log(
      `    Budget 10:  ${budget10Tokens.toLocaleString().padStart(10)} (${pct(budget10Tokens)}%)`
    );
    console.log(
      `    Targeted:   ${targetedTokens.toLocaleString().padStart(10)} (${pct(targetedTokens)}%)`
    );

    return {
      language: repo.language,
      url: repo.url,
      commit,
      loc,
      naiveTokens,
      fullTokens,
      budget50Tokens,
      budget10Tokens,
      targetedTokens,
    };
  } finally {
    console.log(`  Cleaning up ${tmpDir} ...`);
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log("=== chunkr Token Scaling Benchmark ===\n");

  const csvPath = resolve(import.meta.dir, "token-scaling.csv");
  const header =
    "Language,Repo URL,Commit,LOC,Naive Tokens,Full Tokens,Budget50 Tokens,Budget10 Tokens,Targeted Tokens";
  await Bun.write(csvPath, header + "\n");

  for (let i = 0; i < REPOS.length; i++) {
    const repo = REPOS[i];
    const repoName =
      repo.url.split("/").pop()?.replace(".git", "") ?? "unknown";
    console.log(`\n[${i + 1}/${REPOS.length}] ${repo.language} — ${repoName}`);

    try {
      const result = await benchmarkRepo(repo);
      const row = [
        result.language,
        result.url,
        result.commit,
        result.loc,
        result.naiveTokens,
        result.fullTokens,
        result.budget50Tokens,
        result.budget10Tokens,
        result.targetedTokens,
      ].join(",");

      const existing = await Bun.file(csvPath).text();
      await Bun.write(csvPath, existing + row + "\n");
      console.log(`  Row written to CSV`);
    } catch (err) {
      console.error(`  FAILED: ${err}`);
    }
  }

  console.log(`\nBenchmark complete. Results: ${csvPath}`);
}

main();

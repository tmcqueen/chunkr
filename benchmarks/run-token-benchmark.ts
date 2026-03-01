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
 * Simulate the chunkr exploration workflow by reading directly from the DB.
 * This produces the same data as running CLI commands, but is orders of
 * magnitude faster for large repos.
 *
 * Workflow:
 *   1. summary — file count, chunk count, language breakdown
 *   2. files — list files with chunk counts, filter out test paths
 *   3. query filtered files — metadata only, no bodies
 *   4. chunk exported/public declarations — body only (no metadata)
 */
function simulateExploration(dbPath: string): {
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

  const filteredSet = new Set(filteredFiles);
  let chunksRead = 0;

  for (const [filePath, chunks] of chunksByFile) {
    if (!filteredSet.has(filePath)) continue;

    // Query output: metadata headers for all chunks (no bodies)
    for (const c of chunks) {
      const queryLine = `--- chunk ${c.chunk_index} (lines ${c.start_line}-${c.end_line}) ---\n${c.metadata}\n`;
      totalBytes += Buffer.byteLength(queryLine, "utf-8");
    }

    // 4. Selectively read exported/public chunks (body only, no metadata)
    for (const c of chunks) {
      if (isExportedOrPublic(c.metadata)) {
        const chunkOutput =
          `--- body (lines ${c.start_line}-${c.end_line}) ---\n${c.body}\n`;
        totalBytes += Buffer.byteLength(chunkOutput, "utf-8");
        chunksRead++;
      }
    }
  }

  db.close();

  return {
    totalBytes,
    filesQueried: filteredFiles.length,
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

async function benchmarkRepo(repo: RepoConfig): Promise<{
  language: string;
  url: string;
  commit: string;
  loc: number;
  estimatedTokens: number;
  tokensUsed: number;
}> {
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
    const estimatedTokens = Math.round(bytes / 4);
    console.log(
      `  LOC: ${loc.toLocaleString()}, Estimated tokens: ${estimatedTokens.toLocaleString()}`
    );

    // 5. Init chunkr
    await chunkr(["init", "--lang", repo.langFlag], tmpDir);

    // 6. Index
    console.log(`  Indexing ...`);
    const indexArgs = repo.indexPath ? ["index", repo.indexPath] : ["index"];
    const indexOutput = await chunkr(indexArgs, tmpDir);
    console.log(`  ${indexOutput.trim()}`);

    // 7. Simulate exploration via direct DB access
    const dbPath = join(tmpDir, ".chunkr.db");
    console.log(`  Simulating chunkr exploration ...`);
    const { totalBytes, filesQueried, totalFiles, chunksRead } =
      simulateExploration(dbPath);

    const tokensUsed = Math.round(totalBytes / 4);
    const ratio = ((tokensUsed / estimatedTokens) * 100).toFixed(1);
    console.log(
      `  Files queried: ${filesQueried}/${totalFiles}, Exported chunks read: ${chunksRead}`
    );
    console.log(
      `  Tokens used: ${tokensUsed.toLocaleString()} (${ratio}% of naive)`
    );

    return {
      language: repo.language,
      url: repo.url,
      commit,
      loc,
      estimatedTokens,
      tokensUsed,
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
    "Language,Repo URL,Commit Short Hash,LOC,Estimated Tokens,Tokens Used";
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
        result.estimatedTokens,
        result.tokensUsed,
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

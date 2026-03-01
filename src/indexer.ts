import { resolve, relative } from "path";
import {
  initDb,
  openDb,
  getFile,
  upsertFile,
  upsertChunks,
  getExistingChunkHashes,
  getProjectValue,
  setProjectValue,
  deleteFile,
} from "./db.ts";
import { parseFile, isSupported, getSupportedExtensions } from "./parser.ts";
import { getProjectLang } from "./config.ts";
import type { ChunkRecord } from "./types.ts";

export interface IndexResult {
  filesIndexed: number;
  chunksCreated: number;
  chunksUnchanged: number;
  filesSkipped: number;
  filesDeleted: number;
}

/** Find the project root by walking up to find .git */
export function findProjectRoot(startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  while (dir !== "/") {
    if (Bun.file(resolve(dir, ".git")).size) return dir;
    // Also check if .git is a file (worktree)
    try {
      const stat = require("fs").statSync(resolve(dir, ".git"));
      if (stat) return dir;
    } catch {
      // not found, keep going
    }
    dir = resolve(dir, "..");
  }
  // Fall back to cwd if no .git found
  return resolve(startDir);
}

/** Get the current HEAD commit hash */
async function getHeadCommit(rootDir: string): Promise<string | null> {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: rootDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().trim();
  } catch {
    return null;
  }
}

/** Get files changed since a given commit */
async function getChangedFiles(
  rootDir: string,
  sinceCommit: string
): Promise<string[]> {
  const result = Bun.spawnSync(
    ["git", "diff", "--name-only", sinceCommit, "HEAD"],
    { cwd: rootDir, stdout: "pipe", stderr: "pipe" }
  );
  if (result.exitCode !== 0) return [];
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}

/** Get unstaged/untracked changed files */
async function getUncommittedFiles(rootDir: string): Promise<string[]> {
  // Staged + unstaged changes
  const diff = Bun.spawnSync(["git", "diff", "--name-only", "HEAD"], {
    cwd: rootDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  // Untracked files
  const untracked = Bun.spawnSync(
    ["git", "ls-files", "--others", "--exclude-standard"],
    { cwd: rootDir, stdout: "pipe", stderr: "pipe" }
  );
  const files = new Set<string>();
  if (diff.exitCode === 0) {
    for (const f of diff.stdout.toString().trim().split("\n")) {
      if (f) files.add(f);
    }
  }
  if (untracked.exitCode === 0) {
    for (const f of untracked.stdout.toString().trim().split("\n")) {
      if (f) files.add(f);
    }
  }
  return [...files];
}

/** Scan for all supported files in the project */
async function scanAllFiles(rootDir: string, langName: string): Promise<string[]> {
  const extensions = getSupportedExtensions(langName);
  const globPattern = `**/*.{${extensions.map((e) => e.slice(1)).join(",")}}`;
  const glob = new Bun.Glob(globPattern);
  const files: string[] = [];
  for await (const path of glob.scan({
    cwd: rootDir,
    absolute: false,
    onlyFiles: true,
  })) {
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

function md5(content: string): string {
  return new Bun.CryptoHasher("md5").update(content).digest("hex");
}

/** Main indexing function */
export async function indexProject(
  rootDir: string,
  dbPath?: string
): Promise<IndexResult> {
  const resolvedRoot = resolve(rootDir);
  const resolvedDbPath = dbPath ?? resolve(resolvedRoot, ".chunkr.db");

  // Open or create DB
  let db;
  try {
    db = openDb(resolvedDbPath);
  } catch {
    db = initDb(resolvedDbPath);
  }

  const result: IndexResult = {
    filesIndexed: 0,
    chunksCreated: 0,
    chunksUnchanged: 0,
    filesSkipped: 0,
    filesDeleted: 0,
  };

  // Determine which files need indexing
  const langName = getProjectLang(resolvedRoot);
  const lastCommit = getProjectValue(db, "last_commit");
  const headCommit = await getHeadCommit(resolvedRoot);

  let filesToIndex: string[];
  if (lastCommit && headCommit) {
    // Incremental: committed changes since last index + uncommitted changes
    const committed = await getChangedFiles(resolvedRoot, lastCommit);
    const uncommitted = await getUncommittedFiles(resolvedRoot);
    const allChanged = new Set([...committed, ...uncommitted]);
    filesToIndex = [...allChanged].filter((f) => isSupported(langName, f));
  } else {
    // Full scan
    filesToIndex = await scanAllFiles(resolvedRoot, langName);
  }

  // Index each file
  for (const filePath of filesToIndex) {
    const absPath = resolve(resolvedRoot, filePath);
    const file = Bun.file(absPath);

    // Check if file still exists
    if (!(await file.exists())) {
      // File was deleted — remove from DB
      deleteFile(db, filePath);
      result.filesDeleted++;
      continue;
    }

    const source = await file.text();
    const fileHash = md5(source);

    // Check if file content actually changed
    const existing = getFile(db, filePath);
    if (existing && existing.hash === fileHash) {
      result.filesSkipped++;
      continue;
    }

    // Parse the file
    const newChunks = await parseFile(langName, filePath, source);

    // Get existing chunk hashes to preserve unchanged metadata
    const existingHashes = getExistingChunkHashes(db, filePath);

    // For each new chunk, check if body hash matches existing — preserve metadata if so
    const finalChunks: ChunkRecord[] = newChunks.map((chunk) => {
      const existing = existingHashes.get(chunk.chunkIndex);
      if (existing && existing.hash === chunk.hash) {
        // Body unchanged — preserve existing metadata (keeps descriptions)
        result.chunksUnchanged++;
        return { ...chunk, metadata: existing.metadata };
      }
      result.chunksCreated++;
      return chunk;
    });

    // Upsert file record
    upsertFile(db, {
      path: filePath,
      hash: fileHash,
      gitCommit: headCommit,
      lastIndexed: Date.now(),
    });

    // Upsert chunks
    upsertChunks(db, finalChunks);
    result.filesIndexed++;
  }

  // Store current HEAD
  if (headCommit) {
    setProjectValue(db, "last_commit", headCommit);
  }

  db.close();
  return result;
}

/** Get files changed since last index (for status command) */
export async function getStatus(rootDir: string, dbPath?: string) {
  const resolvedRoot = resolve(rootDir);
  const resolvedDbPath = dbPath ?? resolve(resolvedRoot, ".chunkr.db");

  let db;
  try {
    db = openDb(resolvedDbPath);
  } catch {
    return { lastCommit: null, changedFiles: [], isInitialized: false };
  }

  const langName = getProjectLang(resolvedRoot);
  const lastCommit = getProjectValue(db, "last_commit");
  const headCommit = await getHeadCommit(resolvedRoot);

  let changedFiles: string[] = [];
  if (lastCommit && headCommit) {
    const committed = await getChangedFiles(resolvedRoot, lastCommit);
    const uncommitted = await getUncommittedFiles(resolvedRoot);
    changedFiles = [...new Set([...committed, ...uncommitted])].filter((f) =>
      isSupported(langName, f)
    );
  }

  db.close();
  return { lastCommit, changedFiles, isInitialized: true };
}

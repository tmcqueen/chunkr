import { Database } from "bun:sqlite";
import type { FileRecord, ChunkRecord } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  extension TEXT,
  git_commit TEXT,
  last_indexed INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  body TEXT NOT NULL,
  metadata TEXT NOT NULL,
  UNIQUE(file_path, chunk_index)
);

CREATE TABLE IF NOT EXISTS project (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function migrateExtensionColumn(db: Database): void {
  try {
    db.exec("ALTER TABLE files ADD COLUMN extension TEXT");
  } catch {
    // Column already exists
  }
}

export function initDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrateExtensionColumn(db);
  return db;
}

export function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrateExtensionColumn(db);
  return db;
}

export function getFile(db: Database, path: string): FileRecord | null {
  const row = db
    .query<{ path: string; hash: string; extension: string | null; git_commit: string | null; last_indexed: number }, [string]>(
      "SELECT path, hash, extension, git_commit, last_indexed FROM files WHERE path = ?"
    )
    .get(path);
  if (!row) return null;
  return { path: row.path, hash: row.hash, extension: row.extension, gitCommit: row.git_commit, lastIndexed: row.last_indexed };
}

export function getFiles(
  db: Database,
  opts?: { extension?: string; pathPrefix?: string }
): { path: string; chunkCount: number }[] {
  let sql = `SELECT f.path, COUNT(c.id) as chunk_count
    FROM files f LEFT JOIN chunks c ON c.file_path = f.path`;
  const conditions: string[] = [];
  const params: string[] = [];

  if (opts?.extension) {
    const ext = opts.extension.startsWith(".") ? opts.extension.slice(1) : opts.extension;
    conditions.push("f.extension = ?");
    params.push(ext);
  }
  if (opts?.pathPrefix) {
    conditions.push("f.path LIKE ?");
    params.push(opts.pathPrefix + "%");
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " GROUP BY f.path ORDER BY f.path";

  return db
    .query<{ path: string; chunk_count: number }, string[]>(sql)
    .all(...params)
    .map((r) => ({ path: r.path, chunkCount: r.chunk_count }));
}

export function upsertFile(db: Database, record: FileRecord): void {
  db.run(
    `INSERT INTO files (path, hash, extension, git_commit, last_indexed)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, extension=excluded.extension, git_commit=excluded.git_commit, last_indexed=excluded.last_indexed`,
    [record.path, record.hash, record.extension, record.gitCommit, record.lastIndexed]
  );
}

export function deleteFile(db: Database, path: string): void {
  db.run("DELETE FROM files WHERE path = ?", [path]);
}

export function getChunksForFile(
  db: Database,
  filePath: string
): Omit<ChunkRecord, "body">[] {
  return db
    .query<Omit<ChunkRecord, "body">, [string]>(
      `SELECT id, file_path as filePath, chunk_index as chunkIndex, start_line as startLine,
              end_line as endLine, hash, metadata
       FROM chunks WHERE file_path = ? ORDER BY chunk_index`
    )
    .all(filePath);
}

export function getChunk(
  db: Database,
  filePath: string,
  startLine: number
): ChunkRecord | null {
  return db
    .query<ChunkRecord, [string, number]>(
      `SELECT id, file_path as filePath, chunk_index as chunkIndex, start_line as startLine,
              end_line as endLine, hash, body, metadata
       FROM chunks WHERE file_path = ? AND start_line = ?`
    )
    .get(filePath, startLine);
}

export function getChunkByIndex(
  db: Database,
  filePath: string,
  chunkIndex: number
): ChunkRecord | null {
  return db
    .query<ChunkRecord, [string, number]>(
      `SELECT id, file_path as filePath, chunk_index as chunkIndex, start_line as startLine,
              end_line as endLine, hash, body, metadata
       FROM chunks WHERE file_path = ? AND chunk_index = ?`
    )
    .get(filePath, chunkIndex);
}

export function getExistingChunkHashes(
  db: Database,
  filePath: string
): Map<number, { hash: string; metadata: string }> {
  const rows = db
    .query<{ chunk_index: number; hash: string; metadata: string }, [string]>(
      "SELECT chunk_index, hash, metadata FROM chunks WHERE file_path = ?"
    )
    .all(filePath);
  const map = new Map<number, { hash: string; metadata: string }>();
  for (const row of rows) {
    map.set(row.chunk_index, { hash: row.hash, metadata: row.metadata });
  }
  return map;
}

export function upsertChunks(db: Database, chunks: ChunkRecord[]): void {
  const insert = db.prepare(
    `INSERT INTO chunks (file_path, chunk_index, start_line, end_line, hash, body, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_path, chunk_index) DO UPDATE SET
       start_line=excluded.start_line, end_line=excluded.end_line,
       hash=excluded.hash, body=excluded.body, metadata=excluded.metadata`
  );
  const deleteStale = db.prepare(
    "DELETE FROM chunks WHERE file_path = ? AND chunk_index >= ?"
  );

  db.transaction(() => {
    for (const c of chunks) {
      insert.run(c.filePath, c.chunkIndex, c.startLine, c.endLine, c.hash, c.body, c.metadata);
    }
    // Remove any leftover chunks if file now has fewer declarations
    if (chunks.length > 0) {
      deleteStale.run(chunks[0].filePath, chunks.length);
    }
  })();
}

export function updateChunkMetadata(
  db: Database,
  chunkId: number,
  metadata: string
): void {
  db.run("UPDATE chunks SET metadata = ? WHERE id = ?", [metadata, chunkId]);
}

export function getProjectValue(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM project WHERE key = ?")
    .get(key);
  return row?.value ?? null;
}

export function setProjectValue(db: Database, key: string, value: string): void {
  db.run(
    "INSERT INTO project (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [key, value]
  );
}

export function getProjectSummary(db: Database): {
  fileCount: number;
  chunkCount: number;
  languages: Record<string, number>;
} {
  const fileCount = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM files").get()?.c ?? 0;
  const chunkCount = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM chunks").get()?.c ?? 0;

  const files = db.query<{ path: string }, []>("SELECT path FROM files").all();
  const languages: Record<string, number> = {};
  for (const f of files) {
    const ext = f.path.split(".").pop() ?? "unknown";
    languages[ext] = (languages[ext] ?? 0) + 1;
  }

  return { fileCount, chunkCount, languages };
}

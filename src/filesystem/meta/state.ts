import { DurableObject } from "cloudflare:workers";
import { basename, dirname, join, relative } from "node:path/posix";
import type { StateResult } from "./errors";

export interface StoredFile {
  path: string;
  id: string;
  kind: "file";
  createdAt: number;
  lastModified: number;
  size: number;
  objectKey: string;
}

export interface StoredDirectory {
  path: string;
  id: string;
  kind: "directory";
  createdAt: number;
  lastModified: number;
}

export type StoredNode = StoredFile | StoredDirectory;

interface FileWrite {
  id: string;
  objectKey: string;
  size: number;
}

interface CopyPlan {
  source: StoredNode[];
  replaced: StoredNode[];
}

export type StoredNodeChange =
  | { kind: "created"; nodeId: string; path: string }
  | { kind: "modified"; nodeId: string; path: string }
  | { kind: "deleted"; nodeId: string; path: string }
  | {
      kind: "moved";
      nodeId: string;
      previousPath: string;
      path: string;
    };

export interface StoredChangeSet {
  cursor: string;
  changes: readonly StoredNodeChange[];
}

export interface StoredChangePage {
  sets: readonly StoredChangeSet[];
  nextCursor: string;
  hasMore: boolean;
}

export interface StoredLockRange {
  start: string;
  length: string;
}

export interface StoredLockConflict {
  owner: { sessionId: string; ownerId: string };
  type: "read" | "write";
  range: StoredLockRange;
}

export interface StoredNamespaceLock {
  token: string;
  root: string;
  scope: "exclusive" | "shared";
  depth: "0" | "infinity";
  timeout?: number;
  owner?: string;
}

export interface StoredNamespaceLockRequest {
  scope: "exclusive" | "shared";
  depth: "0" | "infinity";
  timeout?: number;
  owner?: string;
}

const ROOT = "/";
const LOCK_LEASE_MS = 60_000;

interface ResourceRow {
  path: string;
  id: string;
  kind: "file" | "directory";
  created_at: number;
  last_modified: number;
  object_key: string | null;
  size: number | null;
  [key: string]: SqlStorageValue;
}

interface MetadataRow {
  revision: number;
  journal_id: string;
  [key: string]: SqlStorageValue;
}

interface ChangeSetRow {
  revision: number;
  changes_json: string;
  [key: string]: SqlStorageValue;
}

interface XAttrRow {
  value: ArrayBuffer;
  [key: string]: SqlStorageValue;
}

interface NamespaceLockRow {
  token: string;
  root: string;
  scope: "exclusive" | "shared";
  depth: "0" | "infinity";
  expires_at: number | null;
  owner: string | null;
  [key: string]: SqlStorageValue;
}

interface SessionRow {
  session_id: string;
  expires_at: number;
  [key: string]: SqlStorageValue;
}

interface RecordLockRow {
  id: number;
  node_id: string;
  session_id: string;
  owner_id: string;
  type: "read" | "write";
  start: string;
  length: string;
  [key: string]: SqlStorageValue;
}

interface FlockRow {
  node_id: string;
  session_id: string;
  owner_id: string;
  type: "shared" | "exclusive";
  [key: string]: SqlStorageValue;
}

const normalizeRange = (range: StoredLockRange) => {
  try {
    const start = BigInt(range.start);
    const length = BigInt(range.length);
    if (start < 0n || length < 0n) return undefined;
    return { start: start.toString(), length: length.toString() };
  } catch {
    return undefined;
  }
};

const rangeEnd = (range: StoredLockRange) => {
  const length = BigInt(range.length);
  return length === 0n ? undefined : BigInt(range.start) + length;
};

const rangesOverlap = (left: StoredLockRange, right: StoredLockRange) => {
  const leftEnd = rangeEnd(left);
  const rightEnd = rangeEnd(right);
  return (
    (leftEnd === undefined || BigInt(right.start) < leftEnd) &&
    (rightEnd === undefined || BigInt(left.start) < rightEnd)
  );
};

const subtractRange = (original: StoredLockRange, removal: StoredLockRange) => {
  if (!rangesOverlap(original, removal)) return [original];

  const originalStart = BigInt(original.start);
  const originalEnd = rangeEnd(original);
  const removalStart = BigInt(removal.start);
  const removalEnd = rangeEnd(removal);
  const result: StoredLockRange[] = [];

  if (originalStart < removalStart) {
    const end =
      originalEnd === undefined || removalStart < originalEnd
        ? removalStart
        : originalEnd;
    if (end > originalStart)
      result.push({
        start: originalStart.toString(),
        length: (end - originalStart).toString(),
      });
  }

  if (
    removalEnd !== undefined &&
    (originalEnd === undefined || removalEnd < originalEnd)
  ) {
    const start = originalStart > removalEnd ? originalStart : removalEnd;
    result.push({
      start: start.toString(),
      length:
        originalEnd === undefined ? "0" : (originalEnd - start).toString(),
    });
  }
  return result;
};

export class FileSystemState extends DurableObject {
  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS fs_resources (
          path TEXT PRIMARY KEY,
          parent_path TEXT,
          name TEXT NOT NULL,
          id TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_modified INTEGER NOT NULL,
          object_key TEXT,
          size INTEGER
        )`,
      );
      ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS fs_resources_by_parent_name
         ON fs_resources (parent_path, name)`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS fs_object_refs (
          object_key TEXT PRIMARY KEY,
          ref_count INTEGER NOT NULL CHECK (ref_count > 0)
        )`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS fs_metadata (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL,
          journal_id TEXT NOT NULL
        )`,
      );
      ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO fs_metadata (id, revision, journal_id) VALUES (1, 0, ?)",
        crypto.randomUUID(),
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS fs_change_sets (
          revision INTEGER PRIMARY KEY,
          changes_json TEXT NOT NULL
        )`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS fs_xattrs (
          node_id TEXT NOT NULL,
          name TEXT NOT NULL,
          value BLOB NOT NULL,
          PRIMARY KEY (node_id, name)
        )`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS fs_namespace_locks (
          token TEXT PRIMARY KEY,
          root TEXT NOT NULL,
          scope TEXT NOT NULL,
          depth TEXT NOT NULL,
          expires_at INTEGER,
          owner TEXT
        )`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS fs_sessions (
          session_id TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        )`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS fs_record_locks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          type TEXT NOT NULL,
          start TEXT NOT NULL,
          length TEXT NOT NULL
        )`,
      );
      ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS fs_record_locks_by_node
         ON fs_record_locks (node_id)`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS fs_flocks (
          node_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          type TEXT NOT NULL,
          PRIMARY KEY (node_id, session_id, owner_id)
        )`,
      );
      const now = Date.now();
      ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO fs_resources
         (path, parent_path, name, id, kind, created_at, last_modified)
         VALUES (?, NULL, '', 'root', 'directory', ?, ?)`,
        ROOT,
        now,
        now,
      );
      return Promise.resolve();
    });
  }

  private transaction<T>(callback: () => T) {
    return this.ctx.storage.transactionSync(callback);
  }

  private resource(path: string): StoredNode | undefined {
    const row = this.ctx.storage.sql
      .exec<ResourceRow>(
        `SELECT path, id, kind, created_at, last_modified, object_key, size
         FROM fs_resources WHERE path = ?`,
        path,
      )
      .toArray()[0];
    return row ? this.toNode(row) : undefined;
  }

  private nodeById(nodeId: string) {
    return this.ctx.storage.sql
      .exec<{ id: string; path: string }>(
        "SELECT id, path FROM fs_resources WHERE id = ?",
        nodeId,
      )
      .toArray()[0];
  }

  private toNode(row: ResourceRow): StoredNode {
    const base = {
      path: row.path,
      id: row.id,
      createdAt: row.created_at,
      lastModified: row.last_modified,
    };
    if (row.kind === "directory") return { ...base, kind: "directory" };
    if (row.object_key === null)
      throw new Error("File metadata is missing its object key");
    if (row.size === null) throw new Error("File metadata is missing its size");
    return {
      ...base,
      kind: "file",
      size: row.size,
      objectKey: row.object_key,
    };
  }

  private subtree(path: string) {
    const prefix = path === ROOT ? ROOT : `${path}/`;
    return this.ctx.storage.sql
      .exec<ResourceRow>(
        `SELECT path, id, kind, created_at, last_modified, object_key, size
         FROM fs_resources
         WHERE path = ? OR substr(path, 1, ?) = ?
         ORDER BY length(path), path`,
        path,
        prefix.length,
        prefix,
      )
      .toArray()
      .map((row) => this.toNode(row));
  }

  private insertNode(node: StoredNode) {
    this.ctx.storage.sql.exec(
      `INSERT INTO fs_resources
       (path, parent_path, name, id, kind, created_at, last_modified,
        object_key, size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      node.path,
      node.path === ROOT ? null : dirname(node.path),
      node.path === ROOT ? "" : basename(node.path),
      node.id,
      node.kind,
      node.createdAt,
      node.lastModified,
      node.kind === "file" ? node.objectKey : null,
      node.kind === "file" ? node.size : null,
    );
  }

  private touch(path: string, now: number) {
    this.ctx.storage.sql.exec(
      "UPDATE fs_resources SET last_modified = ? WHERE path = ?",
      now,
      path,
    );
  }

  private removeMetadata(nodes: readonly StoredNode[]) {
    for (const node of nodes) {
      this.ctx.storage.sql.exec(
        "DELETE FROM fs_resources WHERE path = ?",
        node.path,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM fs_xattrs WHERE node_id = ?",
        node.id,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM fs_record_locks WHERE node_id = ?",
        node.id,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM fs_flocks WHERE node_id = ?",
        node.id,
      );
    }
  }

  private removeNamespaceLocks(path: string, recursive: boolean) {
    this.ctx.storage.sql.exec(
      recursive
        ? "DELETE FROM fs_namespace_locks WHERE root = ? OR substr(root, 1, ?) = ?"
        : "DELETE FROM fs_namespace_locks WHERE root = ?",
      ...(recursive ? [path, path.length + 1, `${path}/`] : [path]),
    );
  }

  private copyXattrs(sourceNodeId: string, destinationNodeId: string) {
    this.ctx.storage.sql.exec(
      `INSERT INTO fs_xattrs (node_id, name, value)
       SELECT ?, name, value FROM fs_xattrs WHERE node_id = ?`,
      destinationNodeId,
      sourceNodeId,
    );
  }

  private retainObjectRef(objectKey: string) {
    this.ctx.storage.sql.exec(
      `INSERT INTO fs_object_refs (object_key, ref_count) VALUES (?, 1)
       ON CONFLICT(object_key) DO UPDATE SET ref_count = ref_count + 1`,
      objectKey,
    );
  }

  private releaseObjectRefs(nodes: readonly StoredNode[]) {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      if (node.kind !== "file") continue;
      counts.set(node.objectKey, (counts.get(node.objectKey) ?? 0) + 1);
    }
    const released: string[] = [];
    for (const [objectKey, count] of counts) {
      const reference = this.ctx.storage.sql
        .exec<{ ref_count: number }>(
          "SELECT ref_count FROM fs_object_refs WHERE object_key = ?",
          objectKey,
        )
        .toArray()[0];
      if (!reference || count >= reference.ref_count) {
        this.ctx.storage.sql.exec(
          "DELETE FROM fs_object_refs WHERE object_key = ?",
          objectKey,
        );
        released.push(objectKey);
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE fs_object_refs SET ref_count = ref_count - ? WHERE object_key = ?",
          count,
          objectKey,
        );
      }
    }
    return released;
  }

  private metadata() {
    return this.ctx.storage.sql
      .exec<MetadataRow>(
        "SELECT revision, journal_id FROM fs_metadata WHERE id = 1",
      )
      .one();
  }

  private cursor(revision: number) {
    return `${this.metadata().journal_id}:${revision}`;
  }

  private recordChanges(changes: readonly StoredNodeChange[]) {
    if (!changes.length) return;
    const revision = this.ctx.storage.sql
      .exec<{ revision: number }>(
        "UPDATE fs_metadata SET revision = revision + 1 WHERE id = 1 RETURNING revision",
      )
      .one().revision;
    this.ctx.storage.sql.exec(
      "INSERT INTO fs_change_sets (revision, changes_json) VALUES (?, ?)",
      revision,
      JSON.stringify(changes),
    );
  }

  private parseCursor(cursor: string): StateResult<number> {
    const separator = cursor.lastIndexOf(":");
    if (separator <= 0) return { ok: false, error: "invalid-sync-token" };
    const revisionText = cursor.slice(separator + 1);
    if (!/^\d+$/.test(revisionText))
      return { ok: false, error: "invalid-sync-token" };
    const revision = Number(revisionText);
    const metadata = this.metadata();
    if (
      cursor.slice(0, separator) !== metadata.journal_id ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision > metadata.revision
    )
      return { ok: false, error: "invalid-sync-token" };
    return { ok: true, value: revision };
  }

  private planCopy(
    sourcePath: string,
    destinationPath: string,
    recursive: boolean,
    overwrite: boolean,
  ): StateResult<CopyPlan> {
    const source = this.resource(sourcePath);
    if (!source) return { ok: false, error: "not-found" };
    const destinationIsDescendant = relative(sourcePath, destinationPath);
    const sourceIsDescendant = relative(destinationPath, sourcePath);
    if (
      sourcePath === destinationPath ||
      (source.kind === "directory" &&
        destinationIsDescendant !== "" &&
        !destinationIsDescendant.startsWith("..")) ||
      (sourceIsDescendant !== "" && !sourceIsDescendant.startsWith(".."))
    )
      return { ok: false, error: "invalid-destination" };
    const parent = this.resource(dirname(destinationPath));
    if (!parent) return { ok: false, error: "parent-not-found" };
    if (parent.kind !== "directory")
      return { ok: false, error: "not-directory" };
    const destination = this.resource(destinationPath);
    if (destination && !overwrite)
      return { ok: false, error: "already-exists" };
    return {
      ok: true,
      value: {
        source:
          source.kind === "directory" && recursive
            ? this.subtree(sourcePath)
            : [source],
        replaced: destination ? this.subtree(destinationPath) : [],
      },
    };
  }

  readNode(path: string): StateResult<StoredNode | undefined> {
    return this.transaction(() => ({ ok: true, value: this.resource(path) }));
  }

  readDirectory(path: string): StateResult<StoredNode[]> {
    return this.transaction(() => {
      const node = this.resource(path);
      if (!node) return { ok: false, error: "not-found" };
      if (node.kind !== "directory")
        return { ok: false, error: "not-directory" };
      return {
        ok: true,
        value: this.ctx.storage.sql
          .exec<ResourceRow>(
            `SELECT path, id, kind, created_at, last_modified, object_key, size
             FROM fs_resources WHERE parent_path = ? ORDER BY name`,
            path,
          )
          .toArray()
          .map((row) => this.toNode(row)),
      };
    });
  }

  writeFile(
    path: string,
    file: FileWrite,
  ): StateResult<{ node: StoredFile; releasedObjectKeys: string[] }> {
    return this.transaction(() => {
      const parent = this.resource(dirname(path));
      if (!parent) return { ok: false, error: "parent-not-found" };
      if (parent.kind !== "directory")
        return { ok: false, error: "not-directory" };
      const existing = this.resource(path);
      if (existing?.kind === "directory")
        return { ok: false, error: "already-exists" };
      const now = Date.now();
      const node: StoredFile = {
        path,
        id: existing?.id ?? file.id,
        kind: "file",
        createdAt: existing?.createdAt ?? now,
        lastModified: now,
        size: file.size,
        objectKey: file.objectKey,
      };
      const releasedObjectKeys =
        existing?.kind === "file" && existing.objectKey !== file.objectKey
          ? this.releaseObjectRefs([existing])
          : [];
      if (existing) {
        this.ctx.storage.sql.exec(
          `UPDATE fs_resources
           SET id = ?, last_modified = ?, object_key = ?, size = ?
           WHERE path = ?`,
          node.id,
          node.lastModified,
          node.objectKey,
          node.size,
          path,
        );
      } else this.insertNode(node);
      if (existing?.kind !== "file" || existing.objectKey !== file.objectKey)
        this.retainObjectRef(file.objectKey);
      this.touch(parent.path, now);
      this.recordChanges([
        { kind: existing ? "modified" : "created", nodeId: node.id, path },
      ]);
      return { ok: true, value: { node, releasedObjectKeys } };
    });
  }

  createDirectory(path: string): StateResult<StoredDirectory> {
    return this.transaction(() => {
      if (path === ROOT) return { ok: false, error: "already-exists" };
      const parent = this.resource(dirname(path));
      if (!parent) return { ok: false, error: "parent-not-found" };
      if (parent.kind !== "directory")
        return { ok: false, error: "not-directory" };
      if (this.resource(path)) return { ok: false, error: "already-exists" };
      const now = Date.now();
      const node: StoredDirectory = {
        path,
        id: crypto.randomUUID(),
        kind: "directory",
        createdAt: now,
        lastModified: now,
      };
      this.insertNode(node);
      this.touch(parent.path, now);
      this.recordChanges([{ kind: "created", nodeId: node.id, path }]);
      return { ok: true, value: node };
    });
  }

  removeNode(
    path: string,
    recursive: boolean,
  ): StateResult<{ nodes: StoredNode[]; releasedObjectKeys: string[] }> {
    return this.transaction(() => {
      const node = this.resource(path);
      if (!node) return { ok: false, error: "not-found" };
      const nodes = this.subtree(path);
      if (node.kind === "directory" && !recursive && nodes.length > 1)
        return { ok: false, error: "directory-not-empty" };
      const releasedObjectKeys = this.releaseObjectRefs(nodes);
      this.removeNamespaceLocks(path, true);
      this.removeMetadata(nodes);
      this.touch(dirname(path), Date.now());
      this.recordChanges(
        nodes.map((removed) => ({
          kind: "deleted" as const,
          nodeId: removed.id,
          path: removed.path,
        })),
      );
      return { ok: true, value: { nodes, releasedObjectKeys } };
    });
  }

  copyNode(
    sourcePath: string,
    destinationPath: string,
    recursive: boolean,
    overwrite: boolean,
  ): StateResult<{ node: StoredNode; releasedObjectKeys: string[] }> {
    return this.transaction(() => {
      const plan = this.planCopy(
        sourcePath,
        destinationPath,
        recursive,
        overwrite,
      );
      if (!plan.ok) return plan;
      const releasedObjectKeys = this.releaseObjectRefs(plan.value.replaced);
      this.removeNamespaceLocks(destinationPath, true);
      this.removeMetadata(plan.value.replaced);
      const now = Date.now();
      const created: StoredNode[] = [];
      for (const source of plan.value.source) {
        const relativePath = relative(sourcePath, source.path);
        const node: StoredNode = {
          ...source,
          path:
            relativePath === ""
              ? destinationPath
              : join(destinationPath, relativePath),
          id: crypto.randomUUID(),
          createdAt: now,
          lastModified: now,
        };
        this.insertNode(node);
        this.copyXattrs(source.id, node.id);
        if (node.kind === "file") this.retainObjectRef(node.objectKey);
        created.push(node);
      }
      this.touch(dirname(destinationPath), now);
      this.recordChanges([
        ...plan.value.replaced.map((removed) => ({
          kind: "deleted" as const,
          nodeId: removed.id,
          path: removed.path,
        })),
        ...created.map((node) => ({
          kind: "created" as const,
          nodeId: node.id,
          path: node.path,
        })),
      ]);
      const node = this.resource(destinationPath);
      return node
        ? { ok: true, value: { node, releasedObjectKeys } }
        : { ok: false, error: "not-found" };
    });
  }

  moveNode(
    sourcePath: string,
    destinationPath: string,
    overwrite: boolean,
  ): StateResult<{ node: StoredNode; releasedObjectKeys: string[] }> {
    return this.transaction(() => {
      const plan = this.planCopy(sourcePath, destinationPath, true, overwrite);
      if (!plan.ok) return plan;
      const releasedObjectKeys = this.releaseObjectRefs(plan.value.replaced);
      this.removeNamespaceLocks(destinationPath, true);
      this.removeMetadata(plan.value.replaced);
      const moved = plan.value.source.map((source) => {
        const relativePath = relative(sourcePath, source.path);
        return {
          node: source,
          previousPath: source.path,
          nextPath:
            relativePath === ""
              ? destinationPath
              : join(destinationPath, relativePath),
        };
      });
      for (const { previousPath, nextPath } of moved)
        this.ctx.storage.sql.exec(
          `UPDATE fs_resources
           SET path = ?, parent_path = ?, name = ?
           WHERE path = ?`,
          nextPath,
          dirname(nextPath),
          basename(nextPath),
          previousPath,
        );
      const now = Date.now();
      this.touch(dirname(sourcePath), now);
      this.touch(dirname(destinationPath), now);
      this.recordChanges([
        ...plan.value.replaced.map((removed) => ({
          kind: "deleted" as const,
          nodeId: removed.id,
          path: removed.path,
        })),
        ...moved.map(({ node, previousPath, nextPath }) => ({
          kind: "moved" as const,
          nodeId: node.id,
          previousPath,
          path: nextPath,
        })),
      ]);
      const node = this.resource(destinationPath);
      return node
        ? { ok: true, value: { node, releasedObjectKeys } }
        : { ok: false, error: "not-found" };
    });
  }

  usedBytes(path: string) {
    return this.transaction(() => {
      const prefix = path === ROOT ? ROOT : `${path}/`;
      return this.ctx.storage.sql
        .exec<{ used_bytes: number }>(
          `SELECT COALESCE(SUM(size), 0) AS used_bytes
           FROM fs_resources
           WHERE kind = 'file' AND (path = ? OR substr(path, 1, ?) = ?)`,
          path,
          prefix.length,
          prefix,
        )
        .one().used_bytes;
    });
  }

  getCurrentCursor(): StateResult<string> {
    return this.transaction(() => ({
      ok: true,
      value: this.cursor(this.metadata().revision),
    }));
  }

  readChanges(after: string, limit?: number): StateResult<StoredChangePage> {
    return this.transaction(() => {
      const parsed = this.parseCursor(after);
      if (!parsed.ok) return parsed;
      const pageSize = Math.max(1, Math.min(limit ?? 100, 1000));
      const rows = this.ctx.storage.sql
        .exec<ChangeSetRow>(
          `SELECT revision, changes_json
           FROM fs_change_sets WHERE revision > ?
           ORDER BY revision LIMIT ?`,
          parsed.value,
          pageSize,
        )
        .toArray();
      const lastRevision = rows.at(-1)?.revision ?? parsed.value;
      const hasMore =
        this.ctx.storage.sql
          .exec<{ revision: number }>(
            "SELECT revision FROM fs_change_sets WHERE revision > ? LIMIT 1",
            lastRevision,
          )
          .toArray().length > 0;
      return {
        ok: true,
        value: {
          sets: rows.map((row) => ({
            cursor: this.cursor(row.revision),
            changes: JSON.parse(row.changes_json) as StoredNodeChange[],
          })),
          nextCursor: this.cursor(lastRevision),
          hasMore,
        },
      };
    });
  }

  getXattr(nodeId: string, name: string): StateResult<Uint8Array | undefined> {
    return this.transaction(() => {
      if (!this.nodeById(nodeId)) return { ok: false, error: "not-found" };
      const row = this.ctx.storage.sql
        .exec<XAttrRow>(
          "SELECT value FROM fs_xattrs WHERE node_id = ? AND name = ?",
          nodeId,
          name,
        )
        .toArray()[0];
      return {
        ok: true,
        value: row ? new Uint8Array(row.value) : undefined,
      };
    });
  }

  listXattrs(nodeId: string): StateResult<readonly string[]> {
    return this.transaction(() => {
      if (!this.nodeById(nodeId)) return { ok: false, error: "not-found" };
      return {
        ok: true,
        value: this.ctx.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM fs_xattrs WHERE node_id = ? ORDER BY name",
            nodeId,
          )
          .toArray()
          .map((row) => row.name),
      };
    });
  }

  setXattr(
    nodeId: string,
    name: string,
    value: Uint8Array,
    mode: "upsert" | "create" | "replace" = "upsert",
  ): StateResult<void> {
    return this.transaction(() => {
      const node = this.nodeById(nodeId);
      if (!node) return { ok: false, error: "not-found" };
      const existing = this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM fs_xattrs WHERE node_id = ? AND name = ?",
          nodeId,
          name,
        )
        .toArray()[0];
      if (mode === "create" && existing)
        return { ok: false, error: "already-exists" };
      if (mode === "replace" && !existing)
        return { ok: false, error: "not-found" };
      this.ctx.storage.sql.exec(
        `INSERT INTO fs_xattrs (node_id, name, value)
         VALUES (?, ?, ?)
         ON CONFLICT(node_id, name) DO UPDATE SET value = excluded.value`,
        nodeId,
        name,
        new Uint8Array(value).buffer,
      );
      this.recordChanges([{ kind: "modified", nodeId, path: node.path }]);
      return { ok: true, value: undefined };
    });
  }

  removeXattr(nodeId: string, name: string): StateResult<void> {
    return this.transaction(() => {
      const node = this.nodeById(nodeId);
      if (!node) return { ok: false, error: "not-found" };
      const existing = this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM fs_xattrs WHERE node_id = ? AND name = ?",
          nodeId,
          name,
        )
        .toArray()[0];
      this.ctx.storage.sql.exec(
        "DELETE FROM fs_xattrs WHERE node_id = ? AND name = ?",
        nodeId,
        name,
      );
      if (existing)
        this.recordChanges([{ kind: "modified", nodeId, path: node.path }]);
      return { ok: true, value: undefined };
    });
  }

  patchXattrs(
    nodeId: string,
    changes: readonly (
      | { kind: "set"; name: string; value: Uint8Array }
      | { kind: "remove"; name: string }
    )[],
  ): StateResult<void> {
    return this.transaction(() => {
      const node = this.nodeById(nodeId);
      if (!node) return { ok: false, error: "not-found" };
      for (const change of changes) {
        if (change.kind === "set") {
          this.ctx.storage.sql.exec(
            `INSERT INTO fs_xattrs (node_id, name, value)
             VALUES (?, ?, ?)
             ON CONFLICT(node_id, name) DO UPDATE SET value = excluded.value`,
            nodeId,
            change.name,
            new Uint8Array(change.value).buffer,
          );
        } else {
          this.ctx.storage.sql.exec(
            "DELETE FROM fs_xattrs WHERE node_id = ? AND name = ?",
            nodeId,
            change.name,
          );
        }
      }
      if (changes.length)
        this.recordChanges([{ kind: "modified", nodeId, path: node.path }]);
      return { ok: true, value: undefined };
    });
  }

  private purgeExpiredNamespaceLocks(now: number) {
    this.ctx.storage.sql.exec(
      "DELETE FROM fs_namespace_locks WHERE expires_at IS NOT NULL AND expires_at <= ?",
      now,
    );
  }

  private namespaceLockApplies(lock: NamespaceLockRow, path: string) {
    const descendant = relative(lock.root, path);
    return (
      lock.root === path ||
      (lock.depth === "infinity" &&
        descendant !== "" &&
        !descendant.startsWith(".."))
    );
  }

  private isDescendant(ancestor: string, path: string) {
    const descendant = relative(ancestor, path);
    return descendant !== "" && !descendant.startsWith("..");
  }

  private storedNamespaceLock(
    row: NamespaceLockRow,
    now: number,
  ): StoredNamespaceLock {
    return {
      token: row.token,
      root: row.root,
      scope: row.scope,
      depth: row.depth,
      ...(row.expires_at === null
        ? {}
        : { timeout: Math.max(0, Math.ceil((row.expires_at - now) / 1000)) }),
      ...(row.owner === null ? {} : { owner: row.owner }),
    };
  }

  getNamespaceLocks(path: string): StateResult<readonly StoredNamespaceLock[]> {
    return this.transaction(() => {
      const now = Date.now();
      this.purgeExpiredNamespaceLocks(now);
      return {
        ok: true,
        value: this.ctx.storage.sql
          .exec<NamespaceLockRow>(
            "SELECT token, root, scope, depth, expires_at, owner FROM fs_namespace_locks",
          )
          .toArray()
          .filter((lock) => this.namespaceLockApplies(lock, path))
          .map((lock) => this.storedNamespaceLock(lock, now)),
      };
    });
  }

  createNamespaceLock(
    path: string,
    request: StoredNamespaceLockRequest,
  ): StateResult<StoredNamespaceLock> {
    return this.transaction(() => {
      const now = Date.now();
      this.purgeExpiredNamespaceLocks(now);
      const conflict = this.ctx.storage.sql
        .exec<NamespaceLockRow>(
          "SELECT token, root, scope, depth, expires_at, owner FROM fs_namespace_locks",
        )
        .toArray()
        .some(
          (lock) =>
            (this.namespaceLockApplies(lock, path) ||
              (request.depth === "infinity" &&
                this.isDescendant(path, lock.root))) &&
            (lock.scope === "exclusive" || request.scope === "exclusive"),
        );
      if (conflict) return { ok: false, error: "locked" };
      const row: NamespaceLockRow = {
        token: `opaquelocktoken:${crypto.randomUUID()}`,
        root: path,
        scope: request.scope,
        depth: request.depth,
        expires_at:
          request.timeout === undefined ? null : now + request.timeout * 1000,
        owner: request.owner ?? null,
      };
      this.ctx.storage.sql.exec(
        `INSERT INTO fs_namespace_locks
         (token, root, scope, depth, expires_at, owner)
         VALUES (?, ?, ?, ?, ?, ?)`,
        row.token,
        row.root,
        row.scope,
        row.depth,
        row.expires_at,
        row.owner,
      );
      return { ok: true, value: this.storedNamespaceLock(row, now) };
    });
  }

  refreshNamespaceLock(
    path: string,
    token: string,
    timeout?: number,
  ): StateResult<StoredNamespaceLock> {
    return this.transaction(() => {
      const now = Date.now();
      this.purgeExpiredNamespaceLocks(now);
      const row = this.ctx.storage.sql
        .exec<NamespaceLockRow>(
          "SELECT token, root, scope, depth, expires_at, owner FROM fs_namespace_locks WHERE token = ?",
          token,
        )
        .toArray()[0];
      if (!row || !this.namespaceLockApplies(row, path))
        return { ok: false, error: "locked" };
      const expiresAt = timeout === undefined ? null : now + timeout * 1000;
      this.ctx.storage.sql.exec(
        "UPDATE fs_namespace_locks SET expires_at = ? WHERE token = ?",
        expiresAt,
        token,
      );
      return {
        ok: true,
        value: this.storedNamespaceLock({ ...row, expires_at: expiresAt }, now),
      };
    });
  }

  unlockNamespaceLock(path: string, token: string): StateResult<void> {
    return this.transaction(() => {
      this.purgeExpiredNamespaceLocks(Date.now());
      const row = this.ctx.storage.sql
        .exec<NamespaceLockRow>(
          "SELECT token, root, scope, depth, expires_at, owner FROM fs_namespace_locks WHERE token = ?",
          token,
        )
        .toArray()[0];
      if (!row || !this.namespaceLockApplies(row, path))
        return { ok: false, error: "precondition-failed" };
      this.ctx.storage.sql.exec(
        "DELETE FROM fs_namespace_locks WHERE token = ?",
        token,
      );
      return { ok: true, value: undefined };
    });
  }

  private purgeExpiredLocks(now: number) {
    const expired = this.ctx.storage.sql
      .exec<SessionRow>(
        "SELECT session_id, expires_at FROM fs_sessions WHERE expires_at <= ?",
        now,
      )
      .toArray();
    for (const session of expired) {
      this.ctx.storage.sql.exec(
        "DELETE FROM fs_record_locks WHERE session_id = ?",
        session.session_id,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM fs_flocks WHERE session_id = ?",
        session.session_id,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM fs_sessions WHERE session_id = ?",
        session.session_id,
      );
    }
  }

  private renewSessionInTransaction(sessionId: string, now: number) {
    this.ctx.storage.sql.exec(
      `INSERT INTO fs_sessions (session_id, expires_at) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET expires_at = excluded.expires_at`,
      sessionId,
      now + LOCK_LEASE_MS,
    );
  }

  private ownRecordLocks(
    nodeId: string,
    owner: { sessionId: string; ownerId: string },
  ) {
    return this.ctx.storage.sql
      .exec<RecordLockRow>(
        `SELECT id, node_id, session_id, owner_id, type, start, length
         FROM fs_record_locks
         WHERE node_id = ? AND session_id = ? AND owner_id = ?`,
        nodeId,
        owner.sessionId,
        owner.ownerId,
      )
      .toArray();
  }

  private removeRecordRange(
    nodeId: string,
    owner: { sessionId: string; ownerId: string },
    removal: StoredLockRange,
  ) {
    for (const lock of this.ownRecordLocks(nodeId, owner)) {
      const original = { start: lock.start, length: lock.length };
      if (!rangesOverlap(original, removal)) continue;
      this.ctx.storage.sql.exec(
        "DELETE FROM fs_record_locks WHERE id = ?",
        lock.id,
      );
      for (const remainder of subtractRange(original, removal))
        this.ctx.storage.sql.exec(
          `INSERT INTO fs_record_locks
           (node_id, session_id, owner_id, type, start, length)
           VALUES (?, ?, ?, ?, ?, ?)`,
          nodeId,
          owner.sessionId,
          owner.ownerId,
          lock.type,
          remainder.start,
          remainder.length,
        );
    }
  }

  private findRecordConflict(
    nodeId: string,
    owner: { sessionId: string; ownerId: string },
    type: "read" | "write",
    range: StoredLockRange,
  ) {
    return this.ctx.storage.sql
      .exec<RecordLockRow>(
        `SELECT id, node_id, session_id, owner_id, type, start, length
         FROM fs_record_locks WHERE node_id = ?`,
        nodeId,
      )
      .toArray()
      .find(
        (lock) =>
          (lock.session_id !== owner.sessionId ||
            lock.owner_id !== owner.ownerId) &&
          rangesOverlap(range, { start: lock.start, length: lock.length }) &&
          (type === "write" || lock.type === "write"),
      );
  }

  private trySetLock(
    nodeId: string,
    owner: { sessionId: string; ownerId: string },
    request: {
      type: "read" | "write" | "unlock";
      range: StoredLockRange;
    },
  ): StateResult<void> {
    return this.transaction(() => {
      const range = normalizeRange(request.range);
      if (!range) return { ok: false, error: "precondition-failed" };
      if (!this.nodeById(nodeId)) return { ok: false, error: "not-found" };
      const now = Date.now();
      this.purgeExpiredLocks(now);
      if (request.type === "unlock") {
        this.removeRecordRange(nodeId, owner, range);
        return { ok: true, value: undefined };
      }
      const conflict = this.findRecordConflict(
        nodeId,
        owner,
        request.type,
        range,
      );
      if (conflict) return { ok: false, error: "locked" };
      this.removeRecordRange(nodeId, owner, range);
      this.ctx.storage.sql.exec(
        `INSERT INTO fs_record_locks
         (node_id, session_id, owner_id, type, start, length)
         VALUES (?, ?, ?, ?, ?, ?)`,
        nodeId,
        owner.sessionId,
        owner.ownerId,
        request.type,
        range.start,
        range.length,
      );
      this.renewSessionInTransaction(owner.sessionId, now);
      return { ok: true, value: undefined };
    });
  }

  getLock(
    nodeId: string,
    owner: { sessionId: string; ownerId: string },
    request: { type: "read" | "write"; range: StoredLockRange },
  ): StateResult<StoredLockConflict | undefined> {
    return this.transaction(() => {
      const range = normalizeRange(request.range);
      if (!range) return { ok: false, error: "precondition-failed" };
      if (!this.nodeById(nodeId)) return { ok: false, error: "not-found" };
      this.purgeExpiredLocks(Date.now());
      const conflict = this.findRecordConflict(
        nodeId,
        owner,
        request.type,
        range,
      );
      return {
        ok: true,
        value: conflict
          ? {
              owner: {
                sessionId: conflict.session_id,
                ownerId: conflict.owner_id,
              },
              type: conflict.type,
              range: { start: conflict.start, length: conflict.length },
            }
          : undefined,
      };
    });
  }

  async setLock(
    nodeId: string,
    owner: { sessionId: string; ownerId: string },
    request: {
      type: "read" | "write" | "unlock";
      range: StoredLockRange;
    },
    options?: { wait?: boolean },
  ): Promise<StateResult<void>> {
    const wait = options?.wait ?? false;
    while (true) {
      const result = this.trySetLock(nodeId, owner, request);
      if (result.ok || result.error !== "locked" || !wait) return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private tryFlock(
    nodeId: string,
    owner: { sessionId: string; ownerId: string },
    type: "shared" | "exclusive" | "unlock",
  ): StateResult<void> {
    return this.transaction(() => {
      if (!this.nodeById(nodeId)) return { ok: false, error: "not-found" };
      const now = Date.now();
      this.purgeExpiredLocks(now);
      if (type === "unlock") {
        this.ctx.storage.sql.exec(
          "DELETE FROM fs_flocks WHERE node_id = ? AND session_id = ? AND owner_id = ?",
          nodeId,
          owner.sessionId,
          owner.ownerId,
        );
        return { ok: true, value: undefined };
      }
      const conflict = this.ctx.storage.sql
        .exec<FlockRow>(
          `SELECT node_id, session_id, owner_id, type
           FROM fs_flocks WHERE node_id = ?`,
          nodeId,
        )
        .toArray()
        .some(
          (lock) =>
            (lock.session_id !== owner.sessionId ||
              lock.owner_id !== owner.ownerId) &&
            (type === "exclusive" || lock.type === "exclusive"),
        );
      if (conflict) return { ok: false, error: "locked" };
      this.ctx.storage.sql.exec(
        `INSERT INTO fs_flocks (node_id, session_id, owner_id, type)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(node_id, session_id, owner_id) DO UPDATE SET type = excluded.type`,
        nodeId,
        owner.sessionId,
        owner.ownerId,
        type,
      );
      this.renewSessionInTransaction(owner.sessionId, now);
      return { ok: true, value: undefined };
    });
  }

  async flock(
    nodeId: string,
    owner: { sessionId: string; ownerId: string },
    type: "shared" | "exclusive" | "unlock",
    options?: { wait?: boolean },
  ): Promise<StateResult<void>> {
    const wait = options?.wait ?? false;
    while (true) {
      const result = this.tryFlock(nodeId, owner, type);
      if (result.ok || result.error !== "locked" || !wait) return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  releaseOwner(owner: {
    sessionId: string;
    ownerId: string;
  }): StateResult<void> {
    return this.transaction(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM fs_record_locks WHERE session_id = ? AND owner_id = ?",
        owner.sessionId,
        owner.ownerId,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM fs_flocks WHERE session_id = ? AND owner_id = ?",
        owner.sessionId,
        owner.ownerId,
      );
      return { ok: true, value: undefined };
    });
  }

  renewSession(sessionId: string): StateResult<void> {
    return this.transaction(() => {
      const now = Date.now();
      this.purgeExpiredLocks(now);
      this.renewSessionInTransaction(sessionId, now);
      return { ok: true, value: undefined };
    });
  }
}

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
  contentType?: string;
  objectKey?: string;
}

interface StoredDirectory {
  path: string;
  id: string;
  kind: "directory";
  createdAt: number;
  lastModified: number;
}

export type StoredResource = StoredFile | StoredDirectory;

interface FileWrite {
  id: string;
  objectKey: string;
  size: number;
  contentType?: string;
}

interface DirectoryCreate {
  id?: string;
}

interface CopyPlan {
  source: StoredResource[];
  replaced: StoredResource[];
}

type StoredSyncChange =
  | { kind: "changed"; path: string; resource: StoredResource }
  | { kind: "removed"; path: string };

interface StoredChangeResult {
  revision: number;
  changes: StoredSyncChange[];
}

const ROOT = "/";

interface ResourceRow {
  path: string;
  id: string;
  kind: "file" | "directory";
  created_at: number;
  last_modified: number;
  object_key: string | null;
  size: number | null;
  content_type: string | null;
  [key: string]: SqlStorageValue;
}

interface ChangeRow {
  path: string;
  kind: "changed" | "removed";
  revision: number;
  [key: string]: SqlStorageValue;
}

interface RevisionRow {
  revision: number;
  [key: string]: SqlStorageValue;
}

interface ObjectRefRow {
  object_key: string;
  ref_count: number;
  [key: string]: SqlStorageValue;
}

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
          size INTEGER,
          content_type TEXT
        )`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS fs_object_refs (
          object_key TEXT PRIMARY KEY,
          ref_count INTEGER NOT NULL CHECK (ref_count > 0)
        )`,
      );
      ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO fs_object_refs (object_key, ref_count)
         SELECT object_key, COUNT(*)
         FROM fs_resources
         WHERE kind = 'file' AND object_key IS NOT NULL
         GROUP BY object_key`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS fs_changes (
          revision INTEGER NOT NULL,
          path TEXT NOT NULL,
          kind TEXT NOT NULL
        )`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS fs_metadata (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL
        )`,
      );
      ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO fs_metadata (id, revision) VALUES (1, 0)",
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

  private resource(path: string) {
    const row = this.ctx.storage.sql
      .exec<ResourceRow>(
        `SELECT path, id, kind, created_at, last_modified, object_key,
                size, content_type
         FROM fs_resources WHERE path = ?`,
        path,
      )
      .toArray()[0];
    return row ? this.toResource(row) : undefined;
  }

  private toResource(row: ResourceRow): StoredResource {
    const base = {
      path: row.path,
      id: row.id,
      createdAt: row.created_at,
      lastModified: row.last_modified,
    };
    if (row.kind === "directory") return { ...base, kind: "directory" };
    return {
      ...base,
      kind: "file",
      size: row.size ?? 0,
      ...(row.content_type ? { contentType: row.content_type } : {}),
      ...(row.object_key ? { objectKey: row.object_key } : {}),
    };
  }

  private subtree(path: string) {
    const prefix = path === ROOT ? ROOT : `${path}/`;
    return this.ctx.storage.sql
      .exec<ResourceRow>(
        `SELECT path, id, kind, created_at, last_modified, object_key,
                size, content_type
         FROM fs_resources
         WHERE path = ? OR substr(path, 1, ?) = ?
         ORDER BY length(path), path`,
        path,
        prefix.length,
        prefix,
      )
      .toArray()
      .map((row) => this.toResource(row));
  }

  private insertResource(resource: StoredResource) {
    this.ctx.storage.sql.exec(
      `INSERT INTO fs_resources
       (path, parent_path, name, id, kind, created_at, last_modified,
        object_key, size, content_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      resource.path,
      resource.path === ROOT ? null : dirname(resource.path),
      resource.path === ROOT ? "" : basename(resource.path),
      resource.id,
      resource.kind,
      resource.createdAt,
      resource.lastModified,
      resource.kind === "file" ? (resource.objectKey ?? null) : null,
      resource.kind === "file" ? resource.size : null,
      resource.kind === "file" ? (resource.contentType ?? null) : null,
    );
  }

  private touch(path: string, now: number) {
    this.ctx.storage.sql.exec(
      "UPDATE fs_resources SET last_modified = ? WHERE path = ?",
      now,
      path,
    );
  }

  private removeMetadata(resources: readonly StoredResource[]) {
    for (const resource of resources) {
      this.ctx.storage.sql.exec(
        "DELETE FROM fs_resources WHERE path = ?",
        resource.path,
      );
    }
  }

  private retainObjectRef(objectKey: string) {
    const existing = this.ctx.storage.sql
      .exec<ObjectRefRow>(
        "SELECT object_key, ref_count FROM fs_object_refs WHERE object_key = ?",
        objectKey,
      )
      .toArray()[0];
    if (existing) {
      this.ctx.storage.sql.exec(
        "UPDATE fs_object_refs SET ref_count = ref_count + 1 WHERE object_key = ?",
        objectKey,
      );
    } else {
      this.ctx.storage.sql.exec(
        "INSERT INTO fs_object_refs (object_key, ref_count) VALUES (?, 1)",
        objectKey,
      );
    }
  }

  private releaseObjectRefs(resources: readonly StoredResource[]): string[] {
    const releases = new Map<string, number>();
    for (const resource of resources) {
      if (resource.kind !== "file" || !resource.objectKey) continue;
      releases.set(
        resource.objectKey,
        (releases.get(resource.objectKey) ?? 0) + 1,
      );
    }

    const released: string[] = [];
    for (const [objectKey, releaseCount] of releases) {
      const reference = this.ctx.storage.sql
        .exec<ObjectRefRow>(
          "SELECT object_key, ref_count FROM fs_object_refs WHERE object_key = ?",
          objectKey,
        )
        .toArray()[0];
      if (!reference) {
        console.error("Missing object reference", objectKey);
        continue;
      }
      if (releaseCount > reference.ref_count) {
        console.error(
          "Object reference count underflow",
          objectKey,
          releaseCount,
          reference.ref_count,
        );
      }
      if (releaseCount >= reference.ref_count) {
        this.ctx.storage.sql.exec(
          "DELETE FROM fs_object_refs WHERE object_key = ?",
          objectKey,
        );
        released.push(objectKey);
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE fs_object_refs SET ref_count = ref_count - ? WHERE object_key = ?",
          releaseCount,
          objectKey,
        );
      }
    }
    return released;
  }

  private recordChanges(
    changes: readonly { path: string; kind: "changed" | "removed" }[],
  ) {
    if (!changes.length) return;
    const revision = this.ctx.storage.sql
      .exec<RevisionRow>(
        "UPDATE fs_metadata SET revision = revision + 1 WHERE id = 1 RETURNING revision",
      )
      .one().revision;
    for (const change of changes) {
      this.ctx.storage.sql.exec(
        "INSERT INTO fs_changes (revision, path, kind) VALUES (?, ?, ?)",
        revision,
        change.path,
        change.kind,
      );
    }
  }

  private revision() {
    return this.ctx.storage.sql
      .exec<RevisionRow>("SELECT revision FROM fs_metadata WHERE id = 1")
      .one().revision;
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
    if (
      sourcePath === destinationPath ||
      (source.kind === "directory" &&
        destinationIsDescendant !== "" &&
        !destinationIsDescendant.startsWith(".."))
    )
      return { ok: false, error: "invalid-destination" };

    const parentResource = this.resource(dirname(destinationPath));
    if (!parentResource) return { ok: false, error: "parent-not-found" };
    if (parentResource.kind !== "directory")
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

  readResource(path: string): StateResult<StoredResource | undefined> {
    return this.transaction(() => {
      const resource = this.resource(path);
      return { ok: true, value: resource };
    });
  }

  readDirectory(path: string): StateResult<StoredResource[]> {
    return this.transaction(() => {
      const directory = this.resource(path);
      if (!directory) return { ok: false, error: "not-found" };
      if (directory.kind !== "directory")
        return { ok: false, error: "not-directory" };
      return {
        ok: true,
        value: this.ctx.storage.sql
          .exec<ResourceRow>(
            `SELECT path, id, kind, created_at, last_modified, object_key,
                    size, content_type
             FROM fs_resources WHERE parent_path = ? ORDER BY name`,
            path,
          )
          .toArray()
          .map((row) => this.toResource(row)),
      };
    });
  }

  writeFile(
    path: string,
    file: FileWrite,
  ): StateResult<{
    resource: StoredFile;
    releasedObjectKeys: string[];
  }> {
    return this.transaction(() => {
      const parentResource = this.resource(dirname(path));
      if (!parentResource) return { ok: false, error: "parent-not-found" };
      if (parentResource.kind !== "directory")
        return { ok: false, error: "not-directory" };

      const existing = this.resource(path);
      if (existing?.kind === "directory")
        return { ok: false, error: "already-exists" };
      const now = Date.now();
      const resource: StoredFile = {
        path,
        id: file.id,
        kind: "file",
        createdAt: existing?.createdAt ?? now,
        lastModified: now,
        size: file.size,
        ...(file.contentType ? { contentType: file.contentType } : {}),
        objectKey: file.objectKey,
      };
      const releasedObjectKeys =
        existing?.kind === "file" && existing.objectKey !== file.objectKey
          ? this.releaseObjectRefs([existing])
          : [];
      const retainNewObject =
        existing?.kind !== "file" || existing.objectKey !== file.objectKey;
      if (existing) {
        this.ctx.storage.sql.exec(
          `UPDATE fs_resources
           SET id = ?, last_modified = ?, object_key = ?, size = ?,
               content_type = ?
           WHERE path = ?`,
          resource.id,
          resource.lastModified,
          resource.objectKey,
          resource.size,
          resource.contentType ?? null,
          path,
        );
      } else {
        this.insertResource(resource);
      }
      if (retainNewObject) this.retainObjectRef(file.objectKey);
      this.touch(parentResource.path, now);
      this.recordChanges([{ path, kind: "changed" }]);
      return {
        ok: true,
        value: {
          resource,
          releasedObjectKeys,
        },
      };
    });
  }

  createDirectory(
    path: string,
    directory: DirectoryCreate = {},
  ): StateResult<StoredDirectory> {
    return this.transaction(() => {
      const created = this.insertDirectory(path, directory);
      if (created.ok) this.recordChanges([{ path, kind: "changed" }]);
      return created;
    });
  }

  private insertDirectory(
    path: string,
    directory: DirectoryCreate,
  ): StateResult<StoredDirectory> {
    if (path === ROOT) return { ok: false, error: "already-exists" };
    const parentResource = this.resource(dirname(path));
    if (!parentResource) return { ok: false, error: "parent-not-found" };
    if (parentResource.kind !== "directory")
      return { ok: false, error: "not-directory" };
    if (this.resource(path)) return { ok: false, error: "already-exists" };

    const now = Date.now();
    const resource: StoredDirectory = {
      path,
      id: directory.id ?? crypto.randomUUID(),
      kind: "directory",
      createdAt: now,
      lastModified: now,
    };
    this.insertResource(resource);
    this.touch(parentResource.path, now);
    return { ok: true, value: resource };
  }

  removeResource(
    path: string,
    recursive: boolean,
  ): StateResult<{
    resources: StoredResource[];
    releasedObjectKeys: string[];
  }> {
    return this.transaction(() => {
      const resource = this.resource(path);
      if (!resource) return { ok: false, error: "not-found" };
      const resources = this.subtree(path);
      if (resource.kind === "directory" && !recursive && resources.length > 1)
        return { ok: false, error: "directory-not-empty" };

      const releasedObjectKeys = this.releaseObjectRefs(resources);
      this.removeMetadata(resources);
      this.touch(dirname(path), Date.now());
      this.recordChanges(
        resources.map((resource) => ({
          path: resource.path,
          kind: "removed" as const,
        })),
      );
      return { ok: true, value: { resources, releasedObjectKeys } };
    });
  }

  copyResource(
    sourcePath: string,
    destinationPath: string,
    recursive: boolean,
    overwrite: boolean,
  ): StateResult<{
    resource: StoredResource;
    releasedObjectKeys: string[];
  }> {
    return this.transaction(() => {
      const plan = this.planCopy(
        sourcePath,
        destinationPath,
        recursive,
        overwrite,
      );
      if (!plan.ok) return plan;

      const releasedObjectKeys = this.releaseObjectRefs(plan.value.replaced);
      this.removeMetadata(plan.value.replaced);
      const now = Date.now();
      for (const source of plan.value.source) {
        const relativePath = relative(sourcePath, source.path);
        const resource: StoredResource = {
          ...source,
          path:
            relativePath === ""
              ? destinationPath
              : join(destinationPath, relativePath),
          id: crypto.randomUUID(),
          createdAt: now,
          lastModified: now,
        };
        this.insertResource(resource);
        if (resource.kind === "file" && resource.objectKey)
          this.retainObjectRef(resource.objectKey);
      }
      this.touch(dirname(destinationPath), now);
      this.recordChanges([
        ...plan.value.replaced.map((resource) => ({
          path: resource.path,
          kind: "removed" as const,
        })),
        ...plan.value.source.map((resource) => {
          const relativePath = relative(sourcePath, resource.path);
          return {
            path:
              relativePath === ""
                ? destinationPath
                : join(destinationPath, relativePath),
            kind: "changed" as const,
          };
        }),
      ]);
      const resource = this.resource(destinationPath);
      return resource
        ? { ok: true, value: { resource, releasedObjectKeys } }
        : { ok: false, error: "not-found" };
    });
  }

  moveResource(
    sourcePath: string,
    destinationPath: string,
    overwrite: boolean,
  ): StateResult<{
    resource: StoredResource;
    releasedObjectKeys: string[];
  }> {
    return this.transaction(() => {
      const plan = this.planCopy(sourcePath, destinationPath, true, overwrite);
      if (!plan.ok) return plan;

      const releasedObjectKeys = this.releaseObjectRefs(plan.value.replaced);
      this.removeMetadata(plan.value.replaced);
      const moved = plan.value.source.map((resource) => {
        const relativePath = relative(sourcePath, resource.path);
        return {
          previousPath: resource.path,
          nextPath:
            relativePath === ""
              ? destinationPath
              : join(destinationPath, relativePath),
        };
      });
      for (const { previousPath, nextPath } of moved) {
        this.ctx.storage.sql.exec(
          "UPDATE fs_resources SET path = ?, parent_path = ?, name = ? WHERE path = ?",
          nextPath,
          dirname(nextPath),
          basename(nextPath),
          previousPath,
        );
      }
      const now = Date.now();
      this.touch(dirname(sourcePath), now);
      this.touch(dirname(destinationPath), now);
      this.recordChanges([
        ...plan.value.replaced.map((resource) => ({
          path: resource.path,
          kind: "removed" as const,
        })),
        ...moved.flatMap(({ previousPath, nextPath }) => [
          { path: previousPath, kind: "removed" as const },
          { path: nextPath, kind: "changed" as const },
        ]),
      ]);
      const resource = this.resource(destinationPath);
      return resource
        ? { ok: true, value: { resource, releasedObjectKeys } }
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

  changesSince(
    collectionPath: string,
    revision: number,
    level: "1" | "infinite",
  ): StateResult<StoredChangeResult> {
    return this.transaction(() => {
      const collection = this.resource(collectionPath);
      if (!collection) return { ok: false, error: "not-found" };
      if (collection.kind !== "directory")
        return { ok: false, error: "not-directory" };
      if (revision > this.revision())
        return { ok: false, error: "invalid-sync-token" };
      const changes = new Map<string, ChangeRow>();
      for (const change of this.ctx.storage.sql
        .exec<ChangeRow>(
          "SELECT path, kind, revision FROM fs_changes WHERE revision > ? ORDER BY revision",
          revision,
        )
        .toArray()) {
        const inScope =
          level === "1"
            ? dirname(change.path) === collectionPath
            : (() => {
                const relativePath = relative(collectionPath, change.path);
                return relativePath !== "" && !relativePath.startsWith("..");
              })();
        if (inScope) changes.set(change.path, change);
      }
      return {
        ok: true,
        value: {
          revision: this.revision(),
          changes: [...changes.values()]
            .sort((left, right) => left.path.localeCompare(right.path))
            .map((change) => {
              const resource =
                change.kind === "changed"
                  ? this.resource(change.path)
                  : undefined;
              return resource
                ? { kind: "changed" as const, path: change.path, resource }
                : { kind: "removed" as const, path: change.path };
            }),
        },
      };
    });
  }
}

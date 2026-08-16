import { DurableObject } from "cloudflare:workers";
import type { EntityTag, Preconditions } from "../../interfaces/object_store";
import { isDescendant, name, parent, remap } from "../vfs/path";
import { matchesPreconditions, newEntityTag } from "./helper";
import {
  ROOT,
  type CopyEntry,
  type CopyPlan,
  type DirectoryCreate,
  type FileWrite,
  type StoredDirectory,
  type StoredFile,
  type StoredResource,
  type StoredChangeResult,
  type StateResult,
} from "./types";

interface ResourceRow {
  path: string;
  id: string;
  kind: "file" | "directory";
  etag: string;
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
          etag TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_modified INTEGER NOT NULL,
          object_key TEXT,
          size INTEGER,
          content_type TEXT
        )`,
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
         (path, parent_path, name, id, kind, etag, created_at, last_modified)
         VALUES (?, NULL, '', 'root', 'directory', ?, ?, ?)`,
        ROOT,
        '"root"',
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
        `SELECT path, id, kind, etag, created_at, last_modified, object_key,
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
      etag: row.etag as EntityTag,
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
        `SELECT path, id, kind, etag, created_at, last_modified, object_key,
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
       (path, parent_path, name, id, kind, etag, created_at, last_modified,
        object_key, size, content_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      resource.path,
      resource.path === ROOT ? null : parent(resource.path),
      resource.path === ROOT ? "" : name(resource.path),
      resource.id,
      resource.kind,
      resource.etag,
      resource.createdAt,
      resource.lastModified,
      resource.kind === "file" ? (resource.objectKey ?? null) : null,
      resource.kind === "file" ? resource.size : null,
      resource.kind === "file" ? (resource.contentType ?? null) : null,
    );
  }

  private touch(path: string, now: number) {
    this.ctx.storage.sql.exec(
      "UPDATE fs_resources SET etag = ?, last_modified = ? WHERE path = ?",
      newEntityTag(),
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
    if (
      sourcePath === destinationPath ||
      (source.kind === "directory" && isDescendant(destinationPath, sourcePath))
    )
      return { ok: false, error: "invalid-destination" };

    const parentResource = this.resource(parent(destinationPath));
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

  readResource(
    path: string,
    preconditions?: Preconditions,
  ): StateResult<StoredResource | undefined> {
    return this.transaction(() => {
      const resource = this.resource(path);
      if (resource && !matchesPreconditions(resource.etag, preconditions))
        return { ok: false, error: "precondition-failed" };
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
            `SELECT path, id, kind, etag, created_at, last_modified, object_key,
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
    preconditions?: Preconditions,
  ): StateResult<{ resource: StoredFile; replacedObjectKey?: string }> {
    return this.transaction(() => {
      const parentResource = this.resource(parent(path));
      if (!parentResource) return { ok: false, error: "parent-not-found" };
      if (parentResource.kind !== "directory")
        return { ok: false, error: "not-directory" };

      const existing = this.resource(path);
      if (existing?.kind === "directory")
        return { ok: false, error: "already-exists" };
      if (!matchesPreconditions(existing?.etag, preconditions))
        return { ok: false, error: "precondition-failed" };

      const now = Date.now();
      const resource: StoredFile = {
        path,
        id: file.id,
        kind: "file",
        etag: newEntityTag(),
        createdAt: existing?.createdAt ?? now,
        lastModified: now,
        size: file.size,
        ...(file.contentType ? { contentType: file.contentType } : {}),
        objectKey: file.objectKey,
      };
      if (existing) {
        this.ctx.storage.sql.exec(
          `UPDATE fs_resources
           SET id = ?, etag = ?, last_modified = ?, object_key = ?, size = ?,
               content_type = ?
           WHERE path = ?`,
          resource.id,
          resource.etag,
          resource.lastModified,
          resource.objectKey,
          resource.size,
          resource.contentType ?? null,
          path,
        );
      } else {
        this.insertResource(resource);
      }
      this.touch(parentResource.path, now);
      this.recordChanges([{ path, kind: "changed" }]);
      return {
        ok: true,
        value: {
          resource,
          ...(existing?.objectKey
            ? { replacedObjectKey: existing.objectKey }
            : {}),
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
    const parentResource = this.resource(parent(path));
    if (!parentResource) return { ok: false, error: "parent-not-found" };
    if (parentResource.kind !== "directory")
      return { ok: false, error: "not-directory" };
    if (this.resource(path)) return { ok: false, error: "already-exists" };

    const now = Date.now();
    const resource: StoredDirectory = {
      path,
      id: directory.id ?? crypto.randomUUID(),
      kind: "directory",
      etag: directory.etag ?? newEntityTag(),
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
  ): StateResult<StoredResource[]> {
    return this.transaction(() => {
      const resource = this.resource(path);
      if (!resource) return { ok: false, error: "not-found" };
      const resources = this.subtree(path);
      if (resource.kind === "directory" && !recursive && resources.length > 1)
        return { ok: false, error: "directory-not-empty" };

      this.removeMetadata(resources);
      this.touch(parent(path), Date.now());
      this.recordChanges(
        resources.map((resource) => ({
          path: resource.path,
          kind: "removed" as const,
        })),
      );
      return { ok: true, value: resources };
    });
  }

  copyPlan(
    sourcePath: string,
    destinationPath: string,
    recursive: boolean,
    overwrite: boolean,
  ) {
    return this.transaction(() =>
      this.planCopy(sourcePath, destinationPath, recursive, overwrite),
    );
  }

  commitCopy(
    sourcePath: string,
    destinationPath: string,
    recursive: boolean,
    overwrite: boolean,
    entries: readonly CopyEntry[],
  ): StateResult<{ resource: StoredResource; replaced: StoredResource[] }> {
    return this.transaction(() => {
      const plan = this.planCopy(
        sourcePath,
        destinationPath,
        recursive,
        overwrite,
      );
      if (!plan.ok) return plan;

      const sourcePaths = new Set(plan.value.source.map(({ path }) => path));
      if (
        entries.length !== sourcePaths.size ||
        entries.some(({ sourcePath }) => !sourcePaths.has(sourcePath))
      )
        return { ok: false, error: "invalid-destination" };

      this.removeMetadata(plan.value.replaced);
      for (const { sourcePath, resource: entryResource } of entries) {
        const resource: StoredResource =
          entryResource.kind === "file"
            ? { ...entryResource, etag: entryResource.etag ?? newEntityTag() }
            : { ...entryResource, etag: entryResource.etag ?? newEntityTag() };
        this.insertResource(resource);
      }
      this.touch(parent(destinationPath), Date.now());
      this.recordChanges([
        ...plan.value.replaced.map((resource) => ({
          path: resource.path,
          kind: "removed" as const,
        })),
        ...entries.map(({ resource }) => ({
          path: resource.path,
          kind: "changed" as const,
        })),
      ]);
      const resource = this.resource(destinationPath);
      return resource
        ? { ok: true, value: { resource, replaced: plan.value.replaced } }
        : { ok: false, error: "not-found" };
    });
  }

  moveResource(
    sourcePath: string,
    destinationPath: string,
    overwrite: boolean,
  ): StateResult<{ resource: StoredResource; replaced: StoredResource[] }> {
    return this.transaction(() => {
      const plan = this.planCopy(sourcePath, destinationPath, true, overwrite);
      if (!plan.ok) return plan;

      this.removeMetadata(plan.value.replaced);
      const moved = plan.value.source.map((resource) => ({
        previousPath: resource.path,
        nextPath: remap(sourcePath, destinationPath, resource.path),
      }));
      for (const { previousPath, nextPath } of moved) {
        this.ctx.storage.sql.exec(
          "UPDATE fs_resources SET path = ?, parent_path = ?, name = ? WHERE path = ?",
          nextPath,
          parent(nextPath),
          name(nextPath),
          previousPath,
        );
      }
      const now = Date.now();
      this.touch(parent(sourcePath), now);
      this.touch(parent(destinationPath), now);
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
        ? { ok: true, value: { resource, replaced: plan.value.replaced } }
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
            ? parent(change.path) === collectionPath
            : isDescendant(change.path, collectionPath);
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

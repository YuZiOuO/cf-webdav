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
  type StoredLock,
  type StoredLockRequest,
  type StoredProperty,
  type StoredProppatchInstruction,
  type StoredResource,
  type StoredSyncResult,
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

interface PropertyRow {
  namespace_uri: string;
  local_name: string;
  value_xml: string;
  [key: string]: SqlStorageValue;
}

interface LockRow {
  token: string;
  root: string;
  scope: StoredLock["scope"];
  depth: StoredLock["depth"];
  expires_at: number | null;
  owner_xml: string | null;
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
        `CREATE TABLE IF NOT EXISTS fs_properties (
          resource_path TEXT NOT NULL,
          namespace_uri TEXT NOT NULL,
          local_name TEXT NOT NULL,
          value_xml TEXT NOT NULL,
          PRIMARY KEY (resource_path, namespace_uri, local_name)
        )`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS fs_locks (
          token TEXT PRIMARY KEY,
          root TEXT NOT NULL,
          scope TEXT NOT NULL,
          depth TEXT NOT NULL,
          expires_at INTEGER,
          owner_xml TEXT
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
        "DELETE FROM fs_properties WHERE resource_path = ?",
        resource.path,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM fs_locks WHERE root = ?",
        resource.path,
      );
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

  private syncToken() {
    return `urn:cf-webdav:sync:${this.revision()}`;
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

  private activeLocks(now: number) {
    this.ctx.storage.sql.exec(
      "DELETE FROM fs_locks WHERE expires_at IS NOT NULL AND expires_at <= ?",
      now,
    );
    return this.ctx.storage.sql
      .exec<LockRow>(
        "SELECT token, root, scope, depth, expires_at, owner_xml FROM fs_locks",
      )
      .toArray()
      .map((lock) => ({
        token: lock.token,
        root: lock.root,
        scope: lock.scope,
        depth: lock.depth,
        ...(lock.expires_at === null
          ? {}
          : {
              timeout: Math.max(0, Math.ceil((lock.expires_at - now) / 1000)),
            }),
        ...(lock.owner_xml ? { owner: lock.owner_xml } : {}),
      }));
  }

  private lockCovers(lock: StoredLock, path: string) {
    return (
      lock.root === path ||
      (lock.depth === "infinity" && isDescendant(path, lock.root))
    );
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

  createDirectoryWithProperties(
    path: string,
    directory: DirectoryCreate,
    properties: readonly StoredProperty[],
  ): StateResult<StoredDirectory> {
    return this.transaction(() => {
      const created = this.insertDirectory(path, directory);
      if (!created.ok) return created;
      for (const property of properties) {
        this.ctx.storage.sql.exec(
          `INSERT INTO fs_properties
           (resource_path, namespace_uri, local_name, value_xml)
           VALUES (?, ?, ?, ?)`,
          path,
          property.namespaceURI,
          property.localName,
          property.xml,
        );
      }
      this.recordChanges([{ path, kind: "changed" }]);
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
        for (const property of this.ctx.storage.sql
          .exec<PropertyRow>(
            `SELECT namespace_uri, local_name, value_xml FROM fs_properties
             WHERE resource_path = ? ORDER BY rowid`,
            sourcePath,
          )
          .toArray()) {
          this.ctx.storage.sql.exec(
            `INSERT INTO fs_properties
             (resource_path, namespace_uri, local_name, value_xml)
             VALUES (?, ?, ?, ?)`,
            resource.path,
            property.namespace_uri,
            property.local_name,
            property.value_xml,
          );
        }
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
        this.ctx.storage.sql.exec(
          "UPDATE fs_properties SET resource_path = ? WHERE resource_path = ?",
          nextPath,
          previousPath,
        );
        this.ctx.storage.sql.exec(
          "UPDATE fs_locks SET root = ? WHERE root = ?",
          nextPath,
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

  getProperties(path: string) {
    return this.transaction(() =>
      this.ctx.storage.sql
        .exec<PropertyRow>(
          `SELECT namespace_uri, local_name, value_xml FROM fs_properties
           WHERE resource_path = ? ORDER BY rowid`,
          path,
        )
        .toArray()
        .map((property) => ({
          namespaceURI: property.namespace_uri,
          localName: property.local_name,
          xml: property.value_xml,
        })),
    );
  }

  patchProperties(
    path: string,
    instructions: readonly StoredProppatchInstruction[],
  ): StateResult<void> {
    return this.transaction(() => {
      if (!this.resource(path)) return { ok: false, error: "not-found" };
      for (const instruction of instructions) {
        const propertyName =
          instruction.kind === "set" ? instruction.property : instruction.name;
        this.ctx.storage.sql.exec(
          `DELETE FROM fs_properties
           WHERE resource_path = ? AND namespace_uri = ? AND local_name = ?`,
          path,
          propertyName.namespaceURI,
          propertyName.localName,
        );
        if (instruction.kind === "set") {
          this.ctx.storage.sql.exec(
            `INSERT INTO fs_properties
             (resource_path, namespace_uri, local_name, value_xml)
             VALUES (?, ?, ?, ?)`,
            path,
            instruction.property.namespaceURI,
            instruction.property.localName,
            instruction.property.xml,
          );
        }
      }
      this.touch(path, Date.now());
      this.recordChanges([{ path, kind: "changed" }]);
      return { ok: true, value: undefined };
    });
  }

  getLocks(path: string) {
    return this.transaction(() => {
      const now = Date.now();
      return this.activeLocks(now).filter((lock) =>
        this.lockCovers(lock, path),
      );
    });
  }

  createLock(
    path: string,
    request: StoredLockRequest,
  ): StateResult<StoredLock> {
    return this.transaction(() => {
      const now = Date.now();
      const conflict = this.activeLocks(now).some(
        (lock) =>
          (this.lockCovers(lock, path) ||
            (request.depth === "infinity" && isDescendant(lock.root, path))) &&
          (lock.scope === "exclusive" || request.scope === "exclusive"),
      );
      if (conflict) return { ok: false, error: "locked" };

      let created: StoredFile | undefined;
      if (!this.resource(path)) {
        const parentResource = this.resource(parent(path));
        if (!parentResource) return { ok: false, error: "parent-not-found" };
        if (parentResource.kind !== "directory")
          return { ok: false, error: "not-directory" };
        created = {
          path,
          id: crypto.randomUUID(),
          kind: "file",
          etag: newEntityTag(),
          createdAt: now,
          lastModified: now,
          size: 0,
        };
        this.insertResource(created);
        this.touch(parentResource.path, now);
      }

      const lock: StoredLock = {
        token: `opaquelocktoken:${crypto.randomUUID()}`,
        root: path,
        scope: request.scope,
        depth: request.depth,
        ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
        ...(request.owner ? { owner: request.owner } : {}),
      };
      this.ctx.storage.sql.exec(
        `INSERT INTO fs_locks (token, root, scope, depth, expires_at, owner_xml)
         VALUES (?, ?, ?, ?, ?, ?)`,
        lock.token,
        lock.root,
        lock.scope,
        lock.depth,
        request.timeout === undefined ? null : now + request.timeout * 1000,
        request.owner ?? null,
      );
      if (created)
        this.recordChanges([{ path: created.path, kind: "changed" }]);
      return { ok: true, value: lock };
    });
  }

  refreshLock(
    path: string,
    token: string,
    timeout?: number,
  ): StateResult<StoredLock> {
    return this.transaction(() => {
      const now = Date.now();
      const lock = this.activeLocks(now).find(
        (candidate) =>
          candidate.token === token && this.lockCovers(candidate, path),
      );
      if (!lock) return { ok: false, error: "locked" };
      this.ctx.storage.sql.exec(
        "UPDATE fs_locks SET expires_at = ? WHERE token = ?",
        timeout === undefined ? null : now + timeout * 1000,
        token,
      );
      return {
        ok: true,
        value: { ...lock, ...(timeout === undefined ? {} : { timeout }) },
      };
    });
  }

  unlock(path: string, token: string): StateResult<void> {
    return this.transaction(() => {
      const now = Date.now();
      if (
        !this.activeLocks(now).some(
          (lock) => lock.token === token && this.lockCovers(lock, path),
        )
      )
        return { ok: false, error: "precondition-failed" };
      this.ctx.storage.sql.exec("DELETE FROM fs_locks WHERE token = ?", token);
      return { ok: true, value: undefined };
    });
  }

  getSyncToken(path: string) {
    return this.transaction(() => {
      const resource = this.resource(path);
      return resource?.kind === "directory" ? this.syncToken() : undefined;
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

  sync(
    collectionPath: string,
    token: string | undefined,
    level: "1" | "infinite",
  ): StateResult<StoredSyncResult> {
    return this.transaction(() => {
      const collection = this.resource(collectionPath);
      if (!collection) return { ok: false, error: "not-found" };
      if (collection.kind !== "directory")
        return { ok: false, error: "not-directory" };

      if (!token) {
        const resources =
          level === "1"
            ? this.ctx.storage.sql
                .exec<ResourceRow>(
                  `SELECT path, id, kind, etag, created_at, last_modified, object_key,
                          size, content_type
                   FROM fs_resources WHERE parent_path = ? ORDER BY name`,
                  collectionPath,
                )
                .toArray()
                .map((row) => this.toResource(row))
            : this.subtree(collectionPath).filter(
                (resource) => resource.path !== collectionPath,
              );
        return {
          ok: true,
          value: {
            changes: resources.map((resource) => ({
              kind: "changed" as const,
              path: resource.path,
              resource,
            })),
            token: this.syncToken(),
          },
        };
      }

      const match = /^urn:cf-webdav:sync:(\d+)$/.exec(token);
      if (!match || Number(match[1]) > this.revision())
        return { ok: false, error: "invalid-sync-token" };

      const changes = new Map<string, ChangeRow>();
      for (const change of this.ctx.storage.sql
        .exec<ChangeRow>(
          "SELECT path, kind, revision FROM fs_changes WHERE revision > ? ORDER BY revision",
          Number(match[1]),
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
          token: this.syncToken(),
        },
      };
    });
  }
}

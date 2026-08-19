import { DurableObject } from "cloudflare:workers";
import { join, relative } from "node:path/posix";
import { HTTPException } from "hono/http-exception";
import { newETag } from "./etag";
import type { EntityTag, LockDepth, LockScope } from "./types";

export interface StoredProperty {
  namespaceURI: string;
  localName: string;
  xml: string;
}

export interface StoredLock {
  token: string;
  root: string;
  scope: LockScope;
  depth: LockDepth;
  timeout?: number;
  owner?: string;
}

interface StoredLockRequest {
  scope: LockScope;
  depth: LockDepth;
  timeout?: number;
  owner?: string;
}

export type StateErrorCode =
  | "not-found"
  | "parent-not-found"
  | "not-directory"
  | "locked"
  | "precondition-failed";

export type StateResult<T> =
  { ok: true; value: T } | { ok: false; error: StateErrorCode };

export const unwrapState = <T>(result: StateResult<T>) => {
  if (result.ok) return result.value;
  switch (result.error) {
    case "not-found":
      throw new HTTPException(404, { message: "Not found" });
    case "parent-not-found":
      throw new HTTPException(409, { message: "Parent directory not found" });
    case "not-directory":
      throw new HTTPException(405, { message: "Not a directory" });
    case "locked":
      throw new HTTPException(423, { message: "Resource is locked" });
    case "precondition-failed":
      throw new HTTPException(412, { message: "Precondition failed" });
  }
};

interface LockRow {
  token: string;
  root: string;
  scope: LockScope;
  depth: LockDepth;
  expires_at: number | null;
  owner_xml: string | null;
  [key: string]: SqlStorageValue;
}

interface PropertyRow {
  resource_path: string;
  namespace_uri: string;
  local_name: string;
  value_xml: string;
  [key: string]: SqlStorageValue;
}

export class WebDavState extends DurableObject {
  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dav_properties (
        resource_path TEXT NOT NULL,
        namespace_uri TEXT NOT NULL,
        local_name TEXT NOT NULL,
        value_xml TEXT NOT NULL,
        PRIMARY KEY (resource_path, namespace_uri, local_name)
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dav_locks (
        token TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        scope TEXT NOT NULL,
        depth TEXT NOT NULL,
        expires_at INTEGER,
        owner_xml TEXT
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dav_etags (
        resource_path TEXT PRIMARY KEY,
        etag TEXT NOT NULL
      )`);
      return Promise.resolve();
    });
  }

  private transaction<T>(callback: () => T) {
    return this.ctx.storage.transactionSync(callback);
  }

  getETag(path: string) {
    return this.transaction(() => {
      const row = this.ctx.storage.sql
        .exec<{ etag: string }>(
          "SELECT etag FROM dav_etags WHERE resource_path = ?",
          path,
        )
        .toArray()[0];
      return row?.etag as EntityTag | undefined;
    });
  }

  ensureETags(paths: readonly string[]) {
    return this.transaction(() => {
      const etags: Record<string, EntityTag> = {};
      if (paths.length === 0) return etags;

      for (let offset = 0; offset < paths.length; offset += 100) {
        const batch = paths.slice(offset, offset + 100);
        const placeholders = batch.map(() => "?").join(", ");
        for (const row of this.ctx.storage.sql
          .exec<{ resource_path: string; etag: string }>(
            `SELECT resource_path, etag FROM dav_etags
             WHERE resource_path IN (${placeholders})`,
            ...batch,
          )
          .toArray()) {
          etags[row.resource_path] = row.etag as EntityTag;
        }
      }

      for (const path of paths) {
        if (etags[path]) continue;
        const etag = newETag();
        this.ctx.storage.sql.exec(
          "INSERT INTO dav_etags (resource_path, etag) VALUES (?, ?)",
          path,
          etag,
        );
        etags[path] = etag;
      }
      return etags;
    });
  }

  setETag(path: string, etag: EntityTag) {
    return this.transaction(() => {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO dav_etags (resource_path, etag) VALUES (?, ?)",
        path,
        etag,
      );
    });
  }

  removeETags(path: string, recursive: boolean) {
    return this.transaction(() => {
      this.ctx.storage.sql.exec(
        recursive
          ? "DELETE FROM dav_etags WHERE resource_path = ? OR substr(resource_path, 1, ?) = ?"
          : "DELETE FROM dav_etags WHERE resource_path = ?",
        ...(recursive ? [path, path.length + 1, `${path}/`] : [path]),
      );
    });
  }

  getPropertiesForPaths(paths: readonly string[]) {
    return this.transaction(() => {
      const properties: Record<string, StoredProperty[]> = {};
      if (paths.length === 0) return properties;

      for (let offset = 0; offset < paths.length; offset += 100) {
        const batch = paths.slice(offset, offset + 100);
        const placeholders = batch.map(() => "?").join(", ");
        for (const row of this.ctx.storage.sql
          .exec<PropertyRow>(
            `SELECT resource_path, namespace_uri, local_name, value_xml
             FROM dav_properties
             WHERE resource_path IN (${placeholders}) ORDER BY rowid`,
            ...batch,
          )
          .toArray()) {
          (properties[row.resource_path] ??= []).push({
            namespaceURI: row.namespace_uri,
            localName: row.local_name,
            xml: row.value_xml,
          });
        }
      }
      return properties;
    });
  }

  patchProperties(
    path: string,
    instructions: readonly (
      | { kind: "set"; property: StoredProperty }
      | {
          kind: "remove";
          name: Pick<StoredProperty, "namespaceURI" | "localName">;
        }
    )[],
  ): StateResult<void> {
    return this.transaction(() => {
      for (const instruction of instructions) {
        const name =
          instruction.kind === "set" ? instruction.property : instruction.name;
        this.ctx.storage.sql.exec(
          `DELETE FROM dav_properties WHERE resource_path = ?
           AND namespace_uri = ? AND local_name = ?`,
          path,
          name.namespaceURI,
          name.localName,
        );
        if (instruction.kind === "set") {
          this.ctx.storage.sql.exec(
            `INSERT INTO dav_properties
             (resource_path, namespace_uri, local_name, value_xml)
             VALUES (?, ?, ?, ?)`,
            path,
            name.namespaceURI,
            name.localName,
            instruction.property.xml,
          );
        }
      }
      return { ok: true, value: undefined };
    });
  }

  copyProperties(source: string, destination: string, recursive: boolean) {
    return this.transaction(() => {
      const prefix = recursive ? `${source}/` : `${source}`;
      const rows = this.ctx.storage.sql
        .exec<PropertyRow>(
          `SELECT resource_path, namespace_uri, local_name, value_xml
         FROM dav_properties WHERE resource_path = ? OR substr(resource_path, 1, ?) = ?`,
          source,
          prefix.length,
          prefix,
        )
        .toArray();
      for (const row of rows) {
        const relativePath = relative(source, row.resource_path);
        const path =
          relativePath === "" ? destination : join(destination, relativePath);
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO dav_properties
           (resource_path, namespace_uri, local_name, value_xml) VALUES (?, ?, ?, ?)`,
          path,
          row.namespace_uri,
          row.local_name,
          row.value_xml,
        );
      }
    });
  }

  moveProperties(source: string, destination: string) {
    return this.transaction(() => {
      const rows = this.ctx.storage.sql
        .exec<PropertyRow>(
          `SELECT resource_path, namespace_uri, local_name, value_xml
         FROM dav_properties WHERE resource_path = ? OR substr(resource_path, 1, ?) = ?`,
          source,
          source.length + 1,
          `${source}/`,
        )
        .toArray();
      for (const row of rows) {
        const relativePath = relative(source, row.resource_path);
        const path =
          relativePath === "" ? destination : join(destination, relativePath);
        this.ctx.storage.sql.exec(
          "UPDATE dav_properties SET resource_path = ? WHERE resource_path = ? AND namespace_uri = ? AND local_name = ?",
          path,
          row.resource_path,
          row.namespace_uri,
          row.local_name,
        );
      }
    });
  }

  removeProperties(path: string, recursive: boolean) {
    return this.transaction(() => {
      this.ctx.storage.sql.exec(
        recursive
          ? "DELETE FROM dav_properties WHERE resource_path = ? OR substr(resource_path, 1, ?) = ?"
          : "DELETE FROM dav_properties WHERE resource_path = ?",
        ...(recursive ? [path, path.length + 1, `${path}/`] : [path]),
      );
      this.ctx.storage.sql.exec(
        recursive
          ? "DELETE FROM dav_locks WHERE root = ? OR substr(root, 1, ?) = ?"
          : "DELETE FROM dav_locks WHERE root = ?",
        ...(recursive ? [path, path.length + 1, `${path}/`] : [path]),
      );
    });
  }

  private activeLocks(now: number) {
    this.ctx.storage.sql.exec(
      "DELETE FROM dav_locks WHERE expires_at IS NOT NULL AND expires_at <= ?",
      now,
    );
    return this.ctx.storage.sql
      .exec<LockRow>(
        "SELECT token, root, scope, depth, expires_at, owner_xml FROM dav_locks",
      )
      .toArray();
  }

  getLocks(path: string) {
    return this.transaction(() =>
      this.activeLocks(Date.now())
        .filter((lock) => {
          const descendant = relative(lock.root, path);
          return (
            lock.root === path ||
            (lock.depth === "infinity" &&
              descendant !== "" &&
              !descendant.startsWith(".."))
          );
        })
        .map((lock) => ({
          token: lock.token,
          root: lock.root,
          scope: lock.scope,
          depth: lock.depth,
          ...(lock.expires_at === null
            ? {}
            : {
                timeout: Math.max(
                  0,
                  Math.ceil((lock.expires_at - Date.now()) / 1000),
                ),
              }),
          ...(lock.owner_xml ? { owner: lock.owner_xml } : {}),
        })),
    );
  }

  createLock(
    path: string,
    request: StoredLockRequest,
  ): StateResult<StoredLock> {
    return this.transaction(() => {
      const now = Date.now();
      const conflict = this.activeLocks(now).some((lock) => {
        const descendant = relative(lock.root, path);
        const ancestor = relative(path, lock.root);
        return (
          (lock.root === path ||
            (lock.depth === "infinity" &&
              descendant !== "" &&
              !descendant.startsWith("..")) ||
            (request.depth === "infinity" &&
              ancestor !== "" &&
              !ancestor.startsWith(".."))) &&
          (lock.scope === "exclusive" || request.scope === "exclusive")
        );
      });
      if (conflict) return { ok: false, error: "locked" };
      const lock = {
        token: `opaquelocktoken:${crypto.randomUUID()}`,
        root: path,
        scope: request.scope,
        depth: request.depth,
        ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
        ...(request.owner ? { owner: request.owner } : {}),
      };
      this.ctx.storage.sql.exec(
        `INSERT INTO dav_locks (token, root, scope, depth, expires_at, owner_xml)
         VALUES (?, ?, ?, ?, ?, ?)`,
        lock.token,
        path,
        request.scope,
        request.depth,
        typeof request.timeout === "number"
          ? now + request.timeout * 1000
          : null,
        request.owner ?? null,
      );
      return { ok: true, value: lock };
    });
  }

  refreshLock(
    path: string,
    token: string,
    timeout?: number,
  ): StateResult<StoredLock> {
    return this.transaction(() => {
      const lock = this.activeLocks(Date.now()).find((candidate) => {
        const descendant = relative(candidate.root, path);
        return (
          candidate.token === token &&
          (candidate.root === path ||
            (candidate.depth === "infinity" &&
              descendant !== "" &&
              !descendant.startsWith("..")))
        );
      });
      if (!lock) return { ok: false, error: "locked" };
      this.ctx.storage.sql.exec(
        "UPDATE dav_locks SET expires_at = ? WHERE token = ?",
        timeout === undefined ? null : Date.now() + timeout * 1000,
        token,
      );
      return {
        ok: true,
        value: {
          token: lock.token,
          root: lock.root,
          scope: lock.scope,
          depth: lock.depth,
          ...(timeout === undefined ? {} : { timeout }),
          ...(lock.owner_xml ? { owner: lock.owner_xml } : {}),
        },
      };
    });
  }

  unlock(path: string, token: string): StateResult<void> {
    return this.transaction(() => {
      const lock = this.activeLocks(Date.now()).find((candidate) => {
        const descendant = relative(candidate.root, path);
        return (
          candidate.token === token &&
          (candidate.root === path ||
            (candidate.depth === "infinity" &&
              descendant !== "" &&
              !descendant.startsWith("..")))
        );
      });
      if (!lock) return { ok: false, error: "precondition-failed" };
      this.ctx.storage.sql.exec("DELETE FROM dav_locks WHERE token = ?", token);
      return { ok: true, value: undefined };
    });
  }
}

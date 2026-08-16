import type { EntityTag } from "../../interfaces/object_store";

export const ROOT = "/";

export type StateError =
  | "not-found"
  | "already-exists"
  | "parent-not-found"
  | "not-directory"
  | "directory-not-empty"
  | "precondition-failed"
  | "locked"
  | "invalid-destination"
  | "invalid-sync-token";

export type StateResult<T> =
  { ok: true; value: T } | { ok: false; error: StateError };

export interface StoredFile {
  path: string;
  id: string;
  kind: "file";
  etag: EntityTag;
  createdAt: number;
  lastModified: number;
  size: number;
  contentType?: string;
  objectKey?: string;
}

export interface StoredDirectory {
  path: string;
  id: string;
  kind: "directory";
  etag: EntityTag;
  createdAt: number;
  lastModified: number;
}

export type StoredResource = StoredFile | StoredDirectory;

export interface StoredProperty {
  namespaceURI: string;
  localName: string;
  xml: string;
}

export type StoredProppatchInstruction =
  | { kind: "set"; property: StoredProperty }
  | {
      kind: "remove";
      name: Pick<StoredProperty, "namespaceURI" | "localName">;
    };

export interface StoredLock {
  token: string;
  root: string;
  scope: "exclusive" | "shared";
  depth: "0" | "infinity";
  timeout?: number;
  owner?: string;
}

export interface StoredLockRequest {
  scope: StoredLock["scope"];
  depth: StoredLock["depth"];
  timeout?: number;
  owner?: string;
}

export interface FileWrite {
  id: string;
  objectKey: string;
  size: number;
  contentType?: string;
}

export interface DirectoryCreate {
  id?: string;
  etag?: EntityTag;
}

export interface CopyPlan {
  source: StoredResource[];
  replaced: StoredResource[];
}

export type CopyEntryResource =
  | (Omit<StoredFile, "etag"> & { etag?: EntityTag })
  | (Omit<StoredDirectory, "etag"> & { etag?: EntityTag });

export interface CopyEntry {
  sourcePath: string;
  resource: CopyEntryResource;
}

export type StoredSyncChange =
  | { kind: "changed"; path: string; resource: StoredResource }
  | { kind: "removed"; path: string };

export interface StoredSyncResult {
  changes: StoredSyncChange[];
  token: string;
}

export interface StoredChangeResult {
  revision: number;
  changes: StoredSyncChange[];
}

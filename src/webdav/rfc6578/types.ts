import type { DavPath, DavResourceInfo } from "../core/types";

export type SyncToken = string & { readonly __syncToken: unique symbol };
export type SyncLevel = "1" | "infinite";

export interface SyncRequest {
  syncToken?: SyncToken;
  syncLevel: SyncLevel;
  limit?: number;
}

export type SyncChange =
  | { kind: "changed"; path: DavPath; resource: DavResourceInfo }
  | { kind: "removed"; path: DavPath }
  | {
      kind: "not-supported";
      path: DavPath;
      error: "supported-report" | "sync-traversal-supported";
    };

export type SyncResult =
  | {
      changes: readonly SyncChange[];
      syncToken: SyncToken;
      truncated: boolean;
    }
  | { error: "valid-sync-token" | "number-of-matches-within-limits" };

export interface DavChangeFeedResult {
  revision: number;
  changes: readonly SyncChange[];
}

export type DavChangeFeed = (
  collection: DavPath,
  revision: number,
  level: SyncLevel,
) => Promise<DavChangeFeedResult>;

export type DavRevisionProvider = (collection: DavPath) => Promise<number>;

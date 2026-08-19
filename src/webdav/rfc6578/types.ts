import type { Path, ResourceInfo } from "../core/types";

export type SyncToken = string & { readonly __syncToken: unique symbol };
export type SyncLevel = "1" | "infinite";

export interface SyncRequest {
  syncToken?: SyncToken;
  syncLevel: SyncLevel;
  limit?: number;
}

export type SyncChange =
  | { kind: "changed"; path: Path; resource: ResourceInfo }
  | { kind: "removed"; path: Path }
  | {
      kind: "not-supported";
      path: Path;
      error: "supported-report" | "sync-traversal-supported";
    };

export type SyncResult =
  | {
      changes: readonly SyncChange[];
      syncToken: SyncToken;
      truncated: boolean;
    }
  | { error: "valid-sync-token" | "number-of-matches-within-limits" };

export interface ChangeFeedResult {
  revision: number;
  changes: readonly SyncChange[];
}

export type ChangeFeed = (
  collection: Path,
  revision: number,
  level: SyncLevel,
) => Promise<ChangeFeedResult>;

export type RevisionProvider = (collection: Path) => Promise<number>;

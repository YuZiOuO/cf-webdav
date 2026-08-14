import type { Path, Resource } from "../file_system";

declare const syncTokenType: unique symbol;

export type SyncToken = string & {
  readonly [syncTokenType]: "SyncToken";
};

export type SyncLevel = "1" | "infinite";

export interface SyncRequest {
  syncToken?: SyncToken;
  syncLevel: SyncLevel;
  limit?: number;
}

export type SyncChange =
  | {
      kind: "changed";
      path: Path;
      resource: Resource;
    }
  | {
      kind: "removed";
      path: Path;
    }
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
  | {
      error: "valid-sync-token" | "number-of-matches-within-limits";
    };

/** RFC 6578 DAV:sync-collection report semantics. */
export interface SyncCollection {
  getSyncToken(collection: Path): Promise<SyncToken | undefined>;
  sync(collection: Path, request: SyncRequest): Promise<SyncResult>;
}

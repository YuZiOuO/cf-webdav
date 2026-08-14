import type { Path } from "../interfaces/file_system";
import type {
  SyncChange,
  SyncCollection,
  SyncRequest,
  SyncResult,
  SyncToken,
} from "../interfaces/webdav/rfc6578";
import { toResource } from "../filesystem/object_store_file_system";
import { unwrapState, type FileSystemState } from "../filesystem/state";

export class DavSync implements SyncCollection {
  constructor(private readonly state: DurableObjectStub<FileSystemState>) {}

  async getSyncToken(collection: Path) {
    const token = await this.state.getSyncToken(collection);
    return token ? (token as SyncToken) : undefined;
  }

  async sync(collection: Path, request: SyncRequest): Promise<SyncResult> {
    const result = await this.state.sync(
      collection,
      request.syncToken,
      request.syncLevel,
    );
    if (!result.ok) {
      if (result.error === "invalid-sync-token")
        return { error: "valid-sync-token" };
      return unwrapState(result);
    }

    const stored = result.value;
    const changes: SyncChange[] = stored.changes.map((change) =>
      change.kind === "changed"
        ? {
            kind: "changed",
            path: change.path as Path,
            resource: toResource(change.resource),
          }
        : { kind: "removed", path: change.path as Path },
    );
    if (request.limit !== undefined && changes.length > request.limit) {
      return {
        changes: changes.slice(0, request.limit),
        syncToken: stored.token as SyncToken,
        truncated: true,
      };
    }
    return {
      changes,
      syncToken: stored.token as SyncToken,
      truncated: false,
    };
  }
}

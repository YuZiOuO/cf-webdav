import type {
  Path,
  FileSystem,
  StorageQuotaProvider,
} from "../../interfaces/file_system";
import type {
  DavPropertyService,
  LockManager,
} from "../../interfaces/webdav/rfc4918";
import type { ExtendedMkcol } from "../../interfaces/webdav/rfc5689";
import type { SyncCollection } from "../../interfaces/webdav/rfc6578";

export type DavEnv = {
  Bindings: CloudflareBindings;
  Variables: {
    path: Path;
    dav: {
      tree: FileSystem;
      properties: DavPropertyService;
      locks: LockManager;
      sync: SyncCollection;
      quota: StorageQuotaProvider;
      mkcol: ExtendedMkcol;
      stateTokenMatches: (path: Path, token: string) => Promise<boolean>;
    };
  };
};

import type {
  DavPropertyService,
  ExtendedMkcol,
  FileSystem,
  LockManager,
  Path,
  StorageQuotaProvider,
  SyncCollection,
} from "../../interfaces";

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

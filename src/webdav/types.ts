import type { DavLocks } from "./rfc4918/locks";
import type { DavProperties } from "./rfc4918/properties";
import type { DavQuotaProvider } from "./rfc4331/types";
import type { DavSync } from "./rfc6578/sync";
import type { DavResourceFactory } from "./core/resource";
import type { DavPath } from "./core/types";

export interface DavContext {
  resource: DavResourceFactory;
  locks: DavLocks;
  properties: DavProperties;
  sync: DavSync;
  quota: DavQuotaProvider;
  stateTokenMatches: (path: DavPath, token: string) => Promise<boolean>;
}

export interface DavEnv {
  Bindings: CloudflareBindings;
  Variables: {
    path: DavPath;
    dav: DavContext;
  };
}

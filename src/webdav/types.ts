import type { Locks } from "./rfc4918/locks";
import type { Properties } from "./rfc4918/properties";
import type { QuotaProvider } from "./rfc4331/types";
import type { Sync } from "./rfc6578/sync";
import type { ResourceFactory } from "./core/resource";
import type { Path } from "./core/types";

export interface Context {
  resource: ResourceFactory;
  locks: Locks;
  properties: Properties;
  sync: Sync;
  quota: QuotaProvider;
  stateTokenMatches: (path: Path, token: string) => Promise<boolean>;
}

export interface Env {
  Bindings: CloudflareBindings;
  Variables: {
    path: Path;
    dav: Context;
  };
}

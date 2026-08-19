import type { DavPath } from "../core/types";
import type { Lock, LockRequest, LockToken } from "./types";
import { parseProperty, serializeProperty } from "../core/xml";
import type { WebDavLock, WebDavState } from "../core/state";
import { unwrapState } from "../core/state";

const toLock = (lock: WebDavLock): Lock => ({
  token: lock.token as LockToken,
  root: lock.root,
  scope: lock.scope,
  depth: lock.depth,
  ...(lock.timeout === undefined ? {} : { timeout: lock.timeout }),
  ...(lock.owner ? { owner: parseProperty(lock.owner).element } : {}),
});

export class DavLocks {
  constructor(private readonly state: DurableObjectStub<WebDavState>) {}

  getSupportedLockScopes() {
    return Promise.resolve(["exclusive", "shared"] as const);
  }

  async getLocks(path: DavPath) {
    return (await this.state.getLocks(path)).map(toLock);
  }

  async lock(path: DavPath, request: LockRequest) {
    return toLock(
      unwrapState(
        await this.state.createLock(path, {
          scope: request.scope,
          depth: request.depth,
          ...(request.timeout === undefined || request.timeout === "infinite"
            ? {}
            : { timeout: request.timeout }),
          ...(request.owner
            ? { owner: serializeProperty({ element: request.owner }) }
            : {}),
        }),
      ),
    );
  }

  async refresh(path: DavPath, token: LockToken, timeout?: Lock["timeout"]) {
    return toLock(
      unwrapState(
        await this.state.refreshLock(
          path,
          token,
          timeout === undefined || timeout === "infinite" ? undefined : timeout,
        ),
      ),
    );
  }

  async unlock(path: DavPath, token: LockToken) {
    unwrapState(await this.state.unlock(path, token));
  }
}

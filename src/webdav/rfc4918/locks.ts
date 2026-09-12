import type { Path } from "../core/types";
import type { Lock, LockRequest, LockToken } from "./types";
import { parseProperty, serializeProperty } from "../core/xml";
import type {
  NamespaceLock,
  NamespaceLockProvider,
  NamespaceLockRequest,
} from "../../interfaces";

const toLock = (lock: NamespaceLock): Lock => ({
  token: lock.token as LockToken,
  root: lock.root,
  scope: lock.scope,
  depth: lock.depth,
  ...(lock.timeout === undefined ? {} : { timeout: lock.timeout }),
  ...(lock.owner ? { owner: parseProperty(lock.owner).element } : {}),
});

export class Locks {
  constructor(private readonly provider: NamespaceLockProvider) {}

  async getLocks(path: Path) {
    return (await this.provider.getNamespaceLocks(path)).map(toLock);
  }

  async lock(path: Path, request: LockRequest) {
    const lockRequest: NamespaceLockRequest = {
      scope: request.scope,
      depth: request.depth,
      ...(request.timeout === undefined || request.timeout === "infinite"
        ? {}
        : { timeout: request.timeout }),
      ...(request.owner
        ? { owner: serializeProperty({ element: request.owner }) }
        : {}),
    };
    return toLock(await this.provider.createNamespaceLock(path, lockRequest));
  }

  async refresh(path: Path, token: LockToken, timeout?: Lock["timeout"]) {
    return toLock(
      await this.provider.refreshNamespaceLock(
        path,
        token,
        timeout === undefined || timeout === "infinite" ? undefined : timeout,
      ),
    );
  }

  async unlock(path: Path, token: LockToken) {
    await this.provider.unlockNamespaceLock(path, token);
  }
}

import type { Path } from "../interfaces/file_system";
import type {
  Lock,
  LockManager,
  LockRequest,
  LockScope,
  LockToken,
} from "../interfaces/webdav/rfc4918";
import { parseProperty, serializeProperty } from "./xml";
import { unwrapState } from "../filesystem/meta/helper";
import type { FileSystemState, StoredLock } from "../filesystem/meta";

const toLock = (lock: StoredLock): Lock => ({
  token: lock.token as LockToken,
  root: lock.root as Path,
  scope: lock.scope,
  depth: lock.depth,
  ...(lock.timeout === undefined ? {} : { timeout: lock.timeout }),
  ...(lock.owner ? { owner: parseProperty(lock.owner).element } : {}),
});

export class DavLocks implements LockManager {
  constructor(private readonly state: DurableObjectStub<FileSystemState>) {}

  getSupportedLockScopes(): Promise<readonly LockScope[]> {
    return Promise.resolve(["exclusive", "shared"]);
  }

  async getLocks(path: Path) {
    return (await this.state.getLocks(path)).map(toLock);
  }

  async lock(path: Path, request: LockRequest) {
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

  async refresh(path: Path, token: LockToken, timeout?: Lock["timeout"]) {
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

  async unlock(path: Path, token: LockToken) {
    unwrapState(await this.state.unlock(path, token));
  }
}

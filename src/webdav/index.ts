import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { methodNotAllowed } from "hono/method-not-allowed";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { FileSystemError } from "../filesystem";
import type { FileSystemErrorCode } from "../filesystem";
import { createR2FileSystem } from "../filesystem";
import { Locks } from "./rfc4918/locks";
import { Properties } from "./rfc4918/properties";
import { decodePath } from "../path";
import { quotaProtectedPropertyNames } from "./rfc4331/quota";
import { Sync, syncProtectedPropertyNames } from "./rfc6578/sync";
import { Resource, toResourceInfo } from "./core/resource";
import type { Path } from "./core/types";
import type { Env } from "./types";
import { rfc4918 } from "./rfc4918/routes";
import { rfc5689 } from "./rfc5689/routes";
import { rfc6578 } from "./rfc6578/routes";

export { WebDavState } from "./core/state";

const app = new Hono<Env>();

app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  if (error instanceof FileSystemError) {
    // Keep the error-code table visually uniform.
    // prettier-ignore
    const status = {
      "invalid-path": 400,
      "not-found": 404,
      "already-exists": 405,
      "parent-not-found": 409,
      "not-directory": 405,
      "not-file": 405,
      "directory-not-empty": 409,
      "locked": 423,
      "precondition-failed": 412,
      "range-not-satisfiable": 416,
      "inconsistent": 500,
    } satisfies Record<FileSystemErrorCode, ContentfulStatusCode>;
    return c.text(error.message, status[error.code]);
  }
  console.error(error);
  return c.text("Internal Server Error", 500);
});

app.use("*", async (c, next) => {
  try {
    const path = decodePath(new URL(c.req.url).pathname);
    const webDavState = c.env.WebDavState.getByName("root");
    const filesystem = createR2FileSystem(c.env);
    const locks = new Locks(webDavState);
    const properties = new Properties(webDavState, locks, [
      ...quotaProtectedPropertyNames,
      ...syncProtectedPropertyNames,
    ]);
    const resource = (target: Path) =>
      new Resource(target, filesystem, webDavState);
    const sync = new Sync(
      resource,
      async (collection, revision, level) => {
        const result = await filesystem.changesSince(
          collection,
          revision,
          level,
        );
        return {
          revision: result.revision,
          changes: result.changes.map((change) =>
            change.kind === "changed"
              ? {
                  kind: "changed",
                  path: change.path,
                  resource: toResourceInfo(change.resource),
                }
              : change,
          ),
        };
      },
      (collection) => filesystem.currentRevision(collection),
    );
    c.set("path", path);
    c.set("dav", {
      resource,
      locks,
      properties,
      sync,
      quota: (target) => filesystem.getQuota(target),
      stateTokenMatches: sync.stateTokenMatches.bind(sync),
    });
  } catch {
    return c.text("Invalid path", 400);
  }
  await next();
});

app.use(methodNotAllowed({ app }));

app.route("/", rfc4918);
app.route("/", rfc5689);
app.route("/", rfc6578);

export default app;

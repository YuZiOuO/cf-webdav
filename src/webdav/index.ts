import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { methodNotAllowed } from "hono/method-not-allowed";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { FileSystemError } from "../filesystem";
import type { FileSystemErrorCode } from "../filesystem";
import { createR2FileSystem } from "../filesystem";
import { DavLocks } from "./rfc4918/locks";
import { DavProperties } from "./rfc4918/properties";
import { decodePath } from "../path";
import { quotaProtectedPropertyNames } from "./rfc4331/quota";
import { DavSync, syncProtectedPropertyNames } from "./rfc6578/sync";
import { DavResource, toDavResourceInfo } from "./core/resource";
import type { DavPath } from "./core/types";
import type { DavEnv } from "./types";
import { rfc4918 } from "./rfc4918/routes";
import { rfc5689 } from "./rfc5689/routes";
import { rfc6578 } from "./rfc6578/routes";

export { WebDavState } from "./core/state";

const app = new Hono<DavEnv>();

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
      "invalid-if": 400,
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
    const locks = new DavLocks(webDavState);
    const properties = new DavProperties(webDavState, locks, [
      ...quotaProtectedPropertyNames,
      ...syncProtectedPropertyNames,
    ]);
    const resource = (target: DavPath) =>
      new DavResource(target, filesystem, webDavState);
    const sync = new DavSync(resource, async (collection, revision, level) => {
      const result = await filesystem.changesSince(collection, revision, level);
      return {
        revision: result.revision,
        changes: result.changes.map((change) =>
          change.kind === "changed"
            ? {
                kind: "changed",
                path: change.path,
                resource: toDavResourceInfo(change.resource),
              }
            : change,
        ),
      };
    });
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

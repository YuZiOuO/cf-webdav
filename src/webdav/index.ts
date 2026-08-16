import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { FileSystemError } from "../filesystem";
import type { FileSystemErrorCode } from "../filesystem";
import { ObjectStoreFileSystem } from "../filesystem";
import { R2ObjectStore } from "../filesystem";
import { DavLocks } from "./rfc4918/locks";
import { DavProperties } from "./core/properties";
import { decodePath } from "../path";
import { DavQuotaProperties, FileSystemQuotaProvider } from "./rfc4331/quota";
import { DavMkcol } from "./rfc5689/mkcol";
import { DavSync, DavSyncProperties } from "./rfc6578/sync";
import { DavTree } from "./core/tree";
import type { DavEnv } from "./core/types";
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
    const filesystem = new ObjectStoreFileSystem(
      new R2ObjectStore(c.env.BUCKET),
      c.env.FileSystemState.getByName("root"),
    );
    const locks = new DavLocks(webDavState);
    const sync = new DavSync(filesystem, filesystem);
    const quota = new FileSystemQuotaProvider(filesystem);
    c.set("path", path);
    c.set("dav", {
      tree: new DavTree(filesystem, webDavState),
      properties: new DavProperties(webDavState, locks, [
        new DavSyncProperties(sync),
        new DavQuotaProperties(quota),
      ]),
      locks,
      sync,
      quota,
      mkcol: new DavMkcol(filesystem, webDavState),
      stateTokenMatches: async (target, token) =>
        token === (await sync.getSyncToken(target)),
    });
  } catch {
    return c.text("Invalid path", 400);
  }
  await next();
});

app.route("/", rfc4918);
app.route("/", rfc5689);
app.route("/", rfc6578);
app.all("*", (c) => c.text("Method Not Allowed", 405));

export default app;

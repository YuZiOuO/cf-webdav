import { basicAuth } from "hono/basic-auth";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  isValidXml,
  lockResponse,
  mkcolResponse,
  multistatus,
  parseLockInfo,
  parseMkcol,
  parsePropfind,
  parseProppatch,
  parseSyncCollection,
} from "./dav_xml";
import { FileSystemError } from "../filesystem/errors";
import {
  ObjectStoreFileSystem,
  emptyBody,
} from "../filesystem/object_store_file_system";
import type {
  FileSystem,
  Path,
  ReadFileOptions,
} from "../interfaces/file_system";
import type { ByteRange } from "../interfaces/object_store";
import type { DavPropfindRequest } from "../interfaces/webdav/rfc4918";
import type { LockToken } from "../interfaces/webdav/rfc4918";
import type { SyncToken } from "../interfaces/webdav/rfc6578";
import { R2ObjectStore } from "../object-store/r2";
import { parent, toPath, href } from "../filesystem/path";
import { WebDav } from "./service";

const ALLOW =
  "OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK, REPORT";

const XML = { "Content-Type": "application/xml; charset=utf-8" };

const app = new Hono<{
  Bindings: CloudflareBindings & {
    WEBDAV_USERNAME: string;
    WEBDAV_PASSWORD: string;
  };
  Variables: { path: Path; filesystem: FileSystem; webdav: WebDav };
}>();

const parseIfTokens = (header: string) =>
  header.match(/<([^>]+)>/g)?.map((value) => value.slice(1, -1).trim()) ?? [];

const parseIfEtags = (header: string) =>
  header.match(/\[([^\]]+)\]/g)?.flatMap((value) =>
    value
      .slice(1, -1)
      .split(",")
      .map((etag) => etag.trim()),
  ) ?? [];

const isLockedWithoutToken = async (
  webdav: WebDav,
  path: Path,
  ifHeader: string | undefined,
) => {
  const tokens = ifHeader ? parseIfTokens(ifHeader) : [];
  const locks = await webdav.getLocks(path);
  return locks.length && !locks.some((lock) => tokens.includes(lock.token));
};

const parseRange = (header: string | undefined): ByteRange | undefined => {
  if (!header) return;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match)
    throw new FileSystemError("range-not-satisfiable", "Invalid Range header");
  return {
    start: Number(match[1]),
    ...(match[2] ? { end: Number(match[2]) } : {}),
  };
};

app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  if (error instanceof FileSystemError) {
    const status = {
      "invalid-path": 400,
      "not-found": 404,
      "already-exists": 405,
      "parent-not-found": 409,
      "not-directory": 405,
      "not-file": 405,
      "directory-not-empty": 409,
      locked: 423,
      "precondition-failed": 412,
      "range-not-satisfiable": 416,
      inconsistent: 500,
    }[error.code] as ContentfulStatusCode;
    return c.text(error.message, status);
  }
  console.error(error);
  return c.text("Internal Server Error", 500);
});

app.use("*", (c, next) =>
  basicAuth({
    username: c.env.WEBDAV_USERNAME,
    password: c.env.WEBDAV_PASSWORD,
  })(c, next),
);

app.use("*", async (c, next) => {
  try {
    const path = toPath(decodeURIComponent(c.req.path));
    const state = c.env.FileSystemState.getByName("root");
    c.set("path", path);
    c.set(
      "filesystem",
      new ObjectStoreFileSystem(new R2ObjectStore(c.env.BUCKET), state),
    );
    c.set("webdav", new WebDav(state));
  } catch {
    return c.text("Invalid path", 400);
  }
  await next();
});

app.options("*", (c) =>
  c.body(null, 204, { Allow: ALLOW, DAV: "1, 2, extended-mkcol" }),
);

app.on("PROPFIND", "*", async (c) => {
  const path = c.get("path");
  const filesystem = c.get("filesystem");
  const depth = (c.req.header("depth") ?? "infinity").toLowerCase();
  if (depth === "infinity")
    return c.body(
      '<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>',
      403,
      XML,
    );
  if (depth !== "0" && depth !== "1")
    return c.text("Invalid Depth header", 400);

  const target = await filesystem.stat(path);
  if (!target) return c.text("Resource not found", 404);

  const body = c.req.raw.body ? await c.req.text() : "";
  if (body && !isValidXml(body)) return c.text("Invalid XML", 400);
  const request: DavPropfindRequest = body
    ? parsePropfind(body)
    : { kind: "allprop" };

  const resources = [{ path, resource: target }];
  if (depth === "1" && target.kind === "directory") {
    for await (const entry of filesystem.readdir(path)) {
      resources.push({
        path: (path === "/"
          ? `/${entry.name}`
          : `${path}/${entry.name}`) as Path,
        resource: entry.resource,
      });
    }
  }

  const webdav = c.get("webdav");
  const responses = await Promise.all(
    resources.map(async (item) => ({
      href: href(item.path, item.resource.kind === "directory"),
      propstats: await webdav.propfind(item.path, item.resource, request),
    })),
  );
  return c.body(multistatus(responses), 207, XML);
});

app.on("PROPPATCH", "*", async (c) => {
  const path = c.get("path");
  const filesystem = c.get("filesystem");
  const resource = await filesystem.stat(path);
  if (!resource) return c.text("Not Found", 404);
  if (await isLockedWithoutToken(c.get("webdav"), path, c.req.header("if")))
    return c.text("Resource is locked", 423);
  const body = await c.req.text();
  if (!isValidXml(body)) return c.text("Invalid XML", 400);
  const propstats = await c
    .get("webdav")
    .proppatch(path, resource, parseProppatch(body));
  return c.body(
    multistatus([
      { href: href(path, resource.kind === "directory"), propstats },
    ]),
    207,
    XML,
  );
});

app.on(["GET", "HEAD"], "*", async (c) => {
  const path = c.get("path");
  const filesystem = c.get("filesystem");
  const file = await filesystem.stat(path);
  if (!file) return c.text("Not Found", 404);
  if (file.kind !== "file") return c.text("Resource is a directory", 405);

  const options: ReadFileOptions = {};
  try {
    options.range = parseRange(c.req.header("range"));
  } catch {
    return c.body(null, 416);
  }
  const content = await filesystem.readFile(path, options);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    ETag: content.file.etag,
    "Last-Modified": content.file.lastModified.toUTCString(),
  });
  if (content.file.contentType)
    headers.set("Content-Type", content.file.contentType);
  const status = content.range ? 206 : 200;
  headers.set(
    "Content-Length",
    String(
      content.range
        ? (content.range.end as number) - content.range.start + 1
        : content.file.size,
    ),
  );
  if (content.range)
    headers.set(
      "Content-Range",
      `bytes ${content.range.start}-${content.range.end as number}/${content.file.size}`,
    );
  if (c.req.method === "HEAD") return c.body(null, { status, headers });
  return c.body(content.body, { status, headers });
});

app.put("*", async (c) => {
  const path = c.get("path");
  if (path === "/") return c.text("Collection", 405, { Allow: ALLOW });
  const filesystem = c.get("filesystem");
  const existing = await filesystem.stat(path);
  if (existing?.kind === "directory")
    return c.text("Collection exists", 405, { Allow: ALLOW });

  const webdav = c.get("webdav");
  const ifHeader = c.req.header("if");
  const tokens = ifHeader ? parseIfTokens(ifHeader) : [];
  const locks = await webdav.getLocks(path);
  const activeLockTokens = new Set<string>(locks.map((lock) => lock.token));
  if (locks.length && !tokens.some((token) => activeLockTokens.has(token)))
    return c.text("Resource is locked", 423);
  if (
    !locks.length &&
    tokens.some(
      (token) =>
        !/^https?:\/\//.test(token) && !token.startsWith("urn:cf-webdav:sync:"),
    )
  )
    return c.body(null, 412);
  if (ifHeader) {
    const etags = parseIfEtags(ifHeader);
    if (etags.length && !etags.includes(existing?.etag ?? ""))
      return c.body(null, 412);
    const syncToken = tokens.find((token) =>
      token.startsWith("urn:cf-webdav:sync:"),
    );
    if (
      syncToken &&
      syncToken !== (await webdav.getSyncToken(parent(path) as Path))
    )
      return c.body(null, 412);
  }

  const file = await filesystem.writeFile(path, {
    body: c.req.raw.body ?? emptyBody(),
    size: Number(c.req.header("content-length") ?? 0),
    ...(c.req.header("content-type")
      ? { contentType: c.req.header("content-type")! }
      : {}),
  });
  return c.body(null, existing ? 204 : 201, {
    ETag: file.etag,
    ...(existing ? {} : { Location: c.req.url }),
  });
});

app.delete("*", async (c) => {
  const path = c.get("path");
  if (path === "/") return c.text("Cannot delete root collection", 403);
  const filesystem = c.get("filesystem");
  if (await isLockedWithoutToken(c.get("webdav"), path, c.req.header("if")))
    return c.text("Resource is locked", 423);
  const target = await filesystem.stat(path);
  if (!target) return c.text("Not Found", 404);
  await filesystem.remove(path, {
    recursive: target.kind === "directory",
  });
  return c.body(null, 204);
});

app.on("MKCOL", "*", async (c) => {
  const path = c.get("path");
  if (path === "/") return c.text("Collection exists", 405, { Allow: ALLOW });
  const filesystem = c.get("filesystem");
  const body = c.req.raw.body ? await c.req.text() : "";
  if (body.trim()) {
    if (!c.req.header("content-type")?.toLowerCase().includes("xml"))
      return c.text("MKCOL body is not supported", 415);
    if (!isValidXml(body)) return c.text("Invalid XML", 400);
    const result = await c.get("webdav").mkcol(path, parseMkcol(body));
    if ("propstats" in result)
      return c.body(mkcolResponse(result.propstats), 403, XML);
    return c.body(null, 201, { Location: c.req.url, ETag: result.etag });
  }
  const directory = await filesystem.mkdir(path);
  return c.body(null, 201, { Location: c.req.url, ETag: directory.etag });
});

app.on(["COPY", "MOVE"], "*", async (c) => {
  const filesystem = c.get("filesystem");
  const source = c.get("path");
  const destinationHeader = c.req.header("destination");
  if (!destinationHeader) return c.text("Invalid Destination header", 400);

  let destination: Path;
  try {
    const destinationUrl = new URL(destinationHeader, c.req.url);
    if (destinationUrl.origin !== new URL(c.req.url).origin)
      return c.text("Cross-origin destinations are not supported", 502);
    destination = toPath(decodeURIComponent(destinationUrl.pathname));
  } catch {
    return c.text("Invalid Destination header", 400);
  }
  if (destination === "/") return c.text("Invalid destination", 403);

  const sourceResource = await filesystem.stat(source);
  if (!sourceResource) return c.text("Not Found", 404);
  const isMove = c.req.method === "MOVE";
  if (
    isMove &&
    (await isLockedWithoutToken(c.get("webdav"), source, c.req.header("if")))
  )
    return c.text("Resource is locked", 423);
  const depth = (c.req.header("depth") ?? "infinity").toLowerCase();
  if (
    sourceResource.kind === "directory" &&
    depth !== "infinity" &&
    (isMove || depth !== "0")
  )
    return c.text("Invalid Depth header", 400);
  const overwriteHeader = (c.req.header("overwrite") ?? "T").toUpperCase();
  if (overwriteHeader !== "T" && overwriteHeader !== "F")
    return c.text("Invalid Overwrite header", 400);

  const overwrite = overwriteHeader === "T";
  const existing = await filesystem.stat(destination);
  if (existing && !overwrite) return c.text("Destination exists", 412);
  if (
    existing &&
    (await isLockedWithoutToken(
      c.get("webdav"),
      destination,
      c.req.header("if"),
    ))
  )
    return c.text("Resource is locked", 423);

  if (isMove) {
    await filesystem.move(source, destination, { overwrite });
  } else {
    await filesystem.copy(source, destination, {
      recursive: sourceResource.kind === "directory" && depth !== "0",
      overwrite,
    });
  }
  return c.body(
    null,
    existing ? 204 : 201,
    existing ? undefined : { Location: destinationHeader },
  );
});

app.on("LOCK", "*", async (c) => {
  const path = c.get("path");
  const filesystem = c.get("filesystem");
  const webdav = c.get("webdav");
  const existing = await filesystem.stat(path);
  const timeoutHeader =
    c.req.header("timeout")?.split(",")[0].trim() ?? "Infinite";
  let seconds: number | undefined;
  if (timeoutHeader !== "Infinite") {
    const match = /^Second-(\d+)$/.exec(timeoutHeader);
    if (!match) return c.text("Invalid Timeout header", 400);
    seconds = Number(match[1]);
  }
  const depth = (c.req.header("depth") ?? "infinity").toLowerCase();
  if (depth !== "0" && depth !== "infinity")
    return c.text("Invalid Depth header", 400);

  const token = c.req.header("if")?.match(/<([^>]+)>/)?.[1];
  const body = c.req.raw.body ? await c.req.text() : "";
  if (!body && !token) return c.text("Lock body is required", 400);
  if (body && !isValidXml(body)) return c.text("Invalid XML", 400);

  const lock = token
    ? await webdav.refresh(path, token as LockToken, seconds)
    : await (async () => {
        const info = parseLockInfo(body);
        return webdav.lock(path, {
          scope: info.scope,
          depth: depth,
          ...(seconds === undefined ? {} : { timeout: seconds }),
          ...(info.owner ? { owner: info.owner } : {}),
        });
      })();
  return c.body(lockResponse(lock), existing ? 200 : 201, {
    "Content-Type": "application/xml; charset=utf-8",
    ...(token ? {} : { "Lock-Token": `<${lock.token}>` }),
    Timeout:
      lock.timeout === undefined || lock.timeout === "infinite"
        ? "Infinite"
        : `Second-${lock.timeout}`,
  });
});

app.on("UNLOCK", "*", async (c) => {
  const token = c.req
    .header("lock-token")
    ?.match(/^<([^>]+)>$/)?.[1]
    ?.trim();
  if (!token) return c.text("Lock token does not match", 400);
  await c.get("webdav").unlock(c.get("path"), token as LockToken);
  return c.body(null, 204);
});

app.on("REPORT", "*", async (c) => {
  const path = c.get("path");
  if (c.req.header("depth") !== "0") return c.text("Invalid Depth header", 400);
  const body = await c.req.text();
  if (!isValidXml(body)) return c.text("Invalid XML", 400);
  const request = parseSyncCollection(body);
  if (request.syncLevel !== "1" && request.syncLevel !== "infinite")
    return c.text("Invalid sync-level", 400);

  const result = await c.get("webdav").sync(path, {
    ...(request.syncToken ? { syncToken: request.syncToken as SyncToken } : {}),
    syncLevel: request.syncLevel,
  });
  if ("error" in result) return c.body(null, 412);

  const responses = await Promise.all(
    result.changes.map(async (change) =>
      change.kind === "changed"
        ? {
            href: href(change.path, change.resource.kind === "directory"),
            propstats: await c
              .get("webdav")
              .propfind(change.path, change.resource, {
                kind: "prop",
                names: request.properties,
              }),
          }
        : {
            href: href(change.path, false),
            propstats: [],
            status: 404,
          },
    ),
  );
  return c.body(multistatus(responses, result.syncToken), 207, XML);
});

app.all("*", (c) => c.text("Method Not Allowed", 405, { Allow: ALLOW }));

export default app;

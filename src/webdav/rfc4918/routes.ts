import { dirname, join } from "node:path/posix";
import { FileSystemError } from "../../filesystem";
import type {
  ByteRange,
  DavPropfindRequest,
  LockManager,
  LockToken,
  Path,
  ReadFileOptions,
} from "../../interfaces";
import type { DavEnv } from "../core/types";
import { Hono } from "hono";
import { ifHeaderMatches, parseIfHeader } from "./if";
import { decodeWebDavPath, toHref } from "../core/path";
import { isValidXml } from "../core/xml";
import {
  multistatus,
  parseLockInfo,
  parsePropfind,
  parseProppatch,
  lockResponse,
} from "./xml";

const XML = { "Content-Type": "application/xml; charset=utf-8" };
const ALLOW =
  "OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK, REPORT";
const DAV = "1, 2, extended-mkcol";

const emptyBody = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

const isLockedWithoutToken = async (
  locks: LockManager,
  path: Path,
  ifHeader: string | undefined,
) => {
  const active = await locks.getLocks(path);
  if (!active.length) return false;
  if (!ifHeader) return true;
  const header = parseIfHeader(ifHeader);
  const submitted = header.flatMap((list) =>
    list.conditions.flatMap((condition) =>
      condition.kind === "state-token" ? [condition.token] : [],
    ),
  );
  return !submitted.some((token) =>
    active.some((lock) => lock.token === token),
  );
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

export const rfc4918 = new Hono<DavEnv>();

rfc4918.options("*", (c) => c.body(null, 204, { Allow: ALLOW, DAV }));

rfc4918.on("PROPFIND", "*", async (c) => {
  const path = c.get("path");
  const resource = c.get("dav").tree;
  const depth = (c.req.header("depth") ?? "infinity").toLowerCase();
  if (depth === "infinity")
    return c.body(
      '<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>',
      403,
      XML,
    );
  if (depth !== "0" && depth !== "1")
    return c.text("Invalid Depth header", 400);
  const target = await resource.stat(path);
  if (!target) return c.text("Resource not found", 404);
  const body = c.req.raw.body ? await c.req.text() : "";
  if (body && !isValidXml(body)) return c.text("Invalid XML", 400);
  const request: DavPropfindRequest = body
    ? parsePropfind(body)
    : { kind: "allprop" };
  const resources = [{ path, resource: target }];
  if (depth === "1" && target.kind === "directory") {
    for await (const entry of resource.readdir(path))
      resources.push({
        path: join(path, entry.name),
        resource: entry.resource,
      });
  }
  const responses = await Promise.all(
    resources.map(async (item) => ({
      href: toHref(item.path, item.resource.kind === "directory"),
      propstats: await c
        .get("dav")
        .properties.propfind(item.path, item.resource, request),
    })),
  );
  return c.body(multistatus(responses), 207, XML);
});

rfc4918.on("PROPPATCH", "*", async (c) => {
  const path = c.get("path");
  const resource = c.get("dav").tree;
  const target = await resource.stat(path);
  if (!target) return c.text("Not Found", 404);
  if (await isLockedWithoutToken(c.get("dav").locks, path, c.req.header("if")))
    return c.text("Resource is locked", 423);
  const body = await c.req.text();
  if (!isValidXml(body)) return c.text("Invalid XML", 400);
  const propstats = await c
    .get("dav")
    .properties.proppatch(path, target, parseProppatch(body));
  const responseHref = toHref(path, target.kind === "directory");
  return c.body(multistatus([{ href: responseHref, propstats }]), 207, XML);
});

rfc4918.on(["GET", "HEAD"], "*", async (c) => {
  const path = c.get("path");
  const resource = c.get("dav").tree;
  const file = await resource.stat(path);
  if (!file) return c.text("Not Found", 404);
  if (file.kind !== "file") return c.text("Resource is a directory", 405);
  const options: ReadFileOptions = {};
  try {
    options.range = parseRange(c.req.header("range"));
  } catch {
    return c.body(null, 416);
  }
  const content = await resource.readFile(path, options);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    ETag: content.file.etag,
    "Last-Modified": content.file.lastModified.toUTCString(),
  });
  if (content.file.contentType)
    headers.set("Content-Type", content.file.contentType);
  const range = content.range;
  const status = range ? 206 : 200;
  const end = range?.end ?? content.file.size - 1;
  headers.set(
    "Content-Length",
    String(range ? end - range.start + 1 : content.file.size),
  );
  if (range)
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${end}/${content.file.size}`,
    );
  if (c.req.method === "HEAD") return c.body(null, { status, headers });
  return c.body(content.body, { status, headers });
});

rfc4918.put("*", async (c) => {
  const path = c.get("path");
  if (path === "/") return c.text("Collection", 405, { Allow: ALLOW });
  const resource = c.get("dav").tree;
  const existing = await resource.stat(path);
  if (existing?.kind === "directory")
    return c.text("Collection exists", 405, { Allow: ALLOW });
  const dav = c.get("dav");
  const ifHeader = c.req.header("if");
  const locks = await dav.locks.getLocks(path);
  if (ifHeader) {
    const header = parseIfHeader(ifHeader);
    const submitted = header.flatMap((list) =>
      list.conditions.flatMap((condition) =>
        condition.kind === "state-token" ? [condition.token] : [],
      ),
    );
    if (
      locks.length &&
      !submitted.some((token) => locks.some((lock) => lock.token === token))
    )
      return c.text("Resource is locked", 423);
    const contextFor = async (target: Path) => {
      const targetResource = await resource.stat(target);
      const targetLocks = await dav.locks.getLocks(target);
      return {
        etag: targetResource?.etag,
        lockTokens: new Set(targetLocks.map((lock) => lock.token)),
      };
    };
    if (
      !(await ifHeaderMatches(header, path, contextFor, (token, target) =>
        dav.stateTokenMatches(target, token),
      ))
    )
      return c.body(null, 412);
  } else if (locks.length) return c.text("Resource is locked", 423);
  const contentType = c.req.header("content-type");
  const file = await resource.writeFile(path, {
    body: c.req.raw.body ?? emptyBody(),
    size: Number(c.req.header("content-length") ?? 0),
    ...(contentType ? { contentType } : {}),
  });
  return c.body(null, existing ? 204 : 201, {
    ETag: file.etag,
    ...(existing ? {} : { Location: c.req.url }),
  });
});

rfc4918.delete("*", async (c) => {
  const path = c.get("path");
  if (path === "/") return c.text("Cannot delete root collection", 403);
  const dav = c.get("dav");
  if (await isLockedWithoutToken(dav.locks, path, c.req.header("if")))
    return c.text("Resource is locked", 423);
  const target = await dav.tree.stat(path);
  if (!target) return c.text("Not Found", 404);
  await dav.tree.remove(path, { recursive: target.kind === "directory" });
  return c.body(null, 204);
});

rfc4918.on(["COPY", "MOVE"], "*", async (c) => {
  const dav = c.get("dav");
  const source = c.get("path");
  const destinationHeader = c.req.header("destination");
  if (!destinationHeader) return c.text("Invalid Destination header", 400);
  let destination: Path;
  try {
    const url = new URL(destinationHeader, c.req.url);
    if (url.origin !== new URL(c.req.url).origin)
      return c.text("Cross-origin destinations are not supported", 502);
    destination = decodeWebDavPath(url.pathname);
  } catch {
    return c.text("Invalid Destination header", 400);
  }
  if (destination === "/") return c.text("Invalid destination", 403);
  const sourceResource = await dav.tree.stat(source);
  if (!sourceResource) return c.text("Not Found", 404);
  const isMove = c.req.method === "MOVE";
  if (
    isMove &&
    (await isLockedWithoutToken(dav.locks, source, c.req.header("if")))
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
  const existing = await dav.tree.stat(destination);
  if (existing && !overwrite) return c.text("Destination exists", 412);
  if (
    existing &&
    (await isLockedWithoutToken(dav.locks, destination, c.req.header("if")))
  )
    return c.text("Resource is locked", 423);
  if (isMove) await dav.tree.move(source, destination, { overwrite });
  else
    await dav.tree.copy(source, destination, {
      recursive: sourceResource.kind === "directory" && depth !== "0",
      overwrite,
    });
  return c.body(
    null,
    existing ? 204 : 201,
    existing ? undefined : { Location: destinationHeader },
  );
});

rfc4918.on("LOCK", "*", async (c) => {
  const path = c.get("path");
  const dav = c.get("dav");
  const existing = await dav.tree.stat(path);
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
  if (
    !token &&
    !existing &&
    (await dav.tree.stat(dirname(path)))?.kind !== "directory"
  )
    return c.text("Parent directory not found", 409);
  const lock = token
    ? await dav.locks.refresh(path, token as LockToken, seconds)
    : await (async () => {
        const info = parseLockInfo(body);
        return dav.locks.lock(path, {
          scope: info.scope,
          depth,
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

rfc4918.on("UNLOCK", "*", async (c) => {
  const token = c.req
    .header("lock-token")
    ?.match(/^<([^>]+)>$/)?.[1]
    ?.trim();
  if (!token) return c.text("Lock token does not match", 400);
  await c.get("dav").locks.unlock(c.get("path"), token as LockToken);
  return c.body(null, 204);
});

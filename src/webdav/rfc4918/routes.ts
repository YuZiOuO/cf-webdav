import type { DavPropfindRequest, LockToken } from "./types";
import type { DavLocks } from "./locks";
import type { DavPath } from "../core/types";
import type { DavEnv } from "../types";
import { Hono } from "hono";
import rangeParser from "range-parser";
import { ifHeaderMatches, parseIfHeader } from "./http";
import { propertyKey } from "./properties";
import { decodePath, toHref } from "../../path";
import { isValidXml } from "../core/xml";
import {
  quotaLiveProperties,
  quotaProtectedPropertyNames,
} from "../rfc4331/quota";
import { syncProtectedPropertyNames } from "../rfc6578/sync";
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

const isLockedWithoutToken = async (
  locks: DavLocks,
  path: DavPath,
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

export const rfc4918 = new Hono<DavEnv>();

rfc4918.options("*", (c) => c.body(null, 204, { Allow: ALLOW, DAV }));

rfc4918.on("PROPFIND", "*", async (c) => {
  const path = c.get("path");
  const resource = c.get("dav").resource(path);
  const depth = (c.req.header("depth") ?? "infinity").toLowerCase();
  if (depth === "infinity")
    return c.body(
      '<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>',
      403,
      XML,
    );
  if (depth !== "0" && depth !== "1")
    return c.text("Invalid Depth header", 400);
  const info = await resource.stat();
  if (!info) return c.text("Resource not found", 404);
  const body = c.req.raw.body ? await c.req.text() : "";
  if (body && !isValidXml(body)) return c.text("Invalid XML", 400);
  const request: DavPropfindRequest = body
    ? parsePropfind(body)
    : { kind: "allprop" };
  const requestedPropertyKeys =
    request.kind === "prop"
      ? new Set(request.names.map(propertyKey))
      : undefined;
  const includeQuota =
    request.kind !== "allprop" &&
    (requestedPropertyKeys === undefined ||
      quotaProtectedPropertyNames.some((name) =>
        requestedPropertyKeys.has(propertyKey(name)),
      ));
  const includeSync =
    requestedPropertyKeys === undefined ||
    syncProtectedPropertyNames.some((name) =>
      requestedPropertyKeys.has(propertyKey(name)),
    );
  const resources = [{ resource, info }];
  if (depth === "1" && info.kind === "collection") {
    for await (const child of resource.children()) {
      resources.push(child);
    }
  }
  const dav = c.get("dav");
  const responses = await Promise.all(
    resources.map(async (item) => {
      const [quota, sync] = await Promise.all([
        quotaLiveProperties(dav.quota, item.resource, item.info, includeQuota),
        includeSync ? dav.sync.liveProperties(item.resource, item.info) : [],
      ]);
      return {
        href: toHref(item.resource.path, item.info.kind === "collection"),
        propstats: await dav.properties.propfind(
          item.resource,
          item.info,
          request,
          [...quota, ...sync],
        ),
      };
    }),
  );
  return c.body(multistatus(responses), 207, XML);
});

rfc4918.on("PROPPATCH", "*", async (c) => {
  const path = c.get("path");
  const resource = c.get("dav").resource(path);
  const info = await resource.stat();
  if (!info) return c.text("Not Found", 404);
  if (await isLockedWithoutToken(c.get("dav").locks, path, c.req.header("if")))
    return c.text("Resource is locked", 423);
  const body = await c.req.text();
  if (!isValidXml(body)) return c.text("Invalid XML", 400);
  const propstats = await c
    .get("dav")
    .properties.proppatch(resource, parseProppatch(body));
  const responseHref = toHref(path, info.kind === "collection");
  return c.body(multistatus([{ href: responseHref, propstats }]), 207, XML);
});

rfc4918.on(["GET", "HEAD"], "*", async (c) => {
  const path = c.get("path");
  const resource = c.get("dav").resource(path);
  const file = await resource.stat();
  if (!file) return c.text("Not Found", 404);
  if (file.kind !== "file") return c.text("Resource is a directory", 405);
  const rangeHeader = c.req.header("range");
  let range: { start: number; end?: number } | undefined;
  if (rangeHeader) {
    const ranges = rangeParser(file.contentLength, rangeHeader);
    if (
      ranges === -1 ||
      ranges === -2 ||
      ranges.type.toLowerCase() !== "bytes" ||
      ranges.length !== 1
    )
      return c.body(null, 416);
    const [parsed] = ranges;
    range = { start: parsed.start, end: parsed.end };
  }
  const content = await resource.readFile(range);
  const etag = await resource.etag();
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cloudflare-CDN-Cache-Control": "public, max-age=60, must-revalidate",
    ETag: etag,
    "Last-Modified": content.file.lastModified.toUTCString(),
  });
  if (content.file.contentType)
    headers.set("Content-Type", content.file.contentType);
  const contentRange = content.range;
  const status = contentRange ? 206 : 200;
  const end = contentRange?.end ?? content.file.contentLength - 1;
  headers.set(
    "Content-Length",
    String(
      contentRange ? end - contentRange.start + 1 : content.file.contentLength,
    ),
  );
  if (contentRange)
    headers.set(
      "Content-Range",
      `bytes ${contentRange.start}-${end}/${content.file.contentLength}`,
    );
  if (c.req.method === "HEAD") return c.body(null, { status, headers });
  return c.body(content.body, { status, headers });
});

rfc4918.put("*", async (c) => {
  const path = c.get("path");
  if (path === "/") return c.text("Collection", 405, { Allow: ALLOW });
  const resource = c.get("dav").resource(path);
  const existing = await resource.stat();
  if (existing?.kind === "collection")
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
    if (
      !(await ifHeaderMatches(
        header,
        path,
        async (target) => {
          const targetResource = dav.resource(target);
          const targetInfo = await targetResource.stat();
          const targetLocks = await dav.locks.getLocks(target);
          return {
            etag: targetInfo ? await targetResource.etag() : undefined,
            lockTokens: new Set(targetLocks.map((lock) => lock.token)),
          };
        },
        (token, target) => dav.stateTokenMatches(target, token),
      ))
    )
      return c.body(null, 412);
  } else if (locks.length) return c.text("Resource is locked", 423);
  const contentType = c.req.header("content-type");
  const etag = await resource.writeFile({
    body:
      c.req.raw.body ??
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
    contentLength: Number(c.req.header("content-length") ?? 0),
    ...(contentType ? { contentType } : {}),
  });
  return c.body(null, existing ? 204 : 201, {
    ETag: etag,
    ...(existing ? {} : { Location: c.req.url }),
  });
});

rfc4918.delete("*", async (c) => {
  const path = c.get("path");
  if (path === "/") return c.text("Cannot delete root collection", 403);
  const dav = c.get("dav");
  if (await isLockedWithoutToken(dav.locks, path, c.req.header("if")))
    return c.text("Resource is locked", 423);
  const resource = dav.resource(path);
  await resource.delete();
  return c.body(null, 204);
});

rfc4918.on(["COPY", "MOVE"], "*", async (c) => {
  const dav = c.get("dav");
  const source = dav.resource(c.get("path"));
  const destinationHeader = c.req.header("destination");
  if (!destinationHeader) return c.text("Invalid Destination header", 400);
  let destination: DavPath;
  try {
    const url = new URL(destinationHeader, c.req.url);
    if (url.origin !== new URL(c.req.url).origin)
      return c.text("Cross-origin destinations are not supported", 502);
    destination = decodePath(url.pathname);
  } catch {
    return c.text("Invalid Destination header", 400);
  }
  if (destination === "/") return c.text("Invalid destination", 403);
  const sourceInfo = await source.stat();
  if (!sourceInfo) return c.text("Not Found", 404);
  const isMove = c.req.method === "MOVE";
  if (
    isMove &&
    (await isLockedWithoutToken(dav.locks, source.path, c.req.header("if")))
  )
    return c.text("Resource is locked", 423);
  const depth = (c.req.header("depth") ?? "infinity").toLowerCase();
  if (
    sourceInfo.kind === "collection" &&
    depth !== "infinity" &&
    (isMove || depth !== "0")
  )
    return c.text("Invalid Depth header", 400);
  const overwriteHeader = (c.req.header("overwrite") ?? "T").toUpperCase();
  if (overwriteHeader !== "T" && overwriteHeader !== "F")
    return c.text("Invalid Overwrite header", 400);
  const overwrite = overwriteHeader === "T";
  const destinationResource = dav.resource(destination);
  const existing = await destinationResource.stat();
  if (existing && !overwrite) return c.text("Destination exists", 412);
  if (
    existing &&
    (await isLockedWithoutToken(dav.locks, destination, c.req.header("if")))
  )
    return c.text("Resource is locked", 423);
  if (isMove) await source.moveTo(destinationResource, overwrite);
  else
    await source.copyTo(destinationResource, {
      depth:
        sourceInfo.kind === "collection" && depth !== "0" ? "infinity" : "0",
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
  const resource = dav.resource(path);
  const existing = await resource.stat();
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
  if (!token && !existing) {
    const parent = resource.parent();
    const parentInfo = parent ? await parent.stat() : undefined;
    if (parentInfo?.kind !== "collection")
      return c.text("Parent directory not found", 409);
  }
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

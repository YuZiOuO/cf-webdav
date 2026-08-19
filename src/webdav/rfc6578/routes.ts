import type { SyncToken } from "./types";
import type { Env } from "../types";
import { Hono } from "hono";
import { toHref } from "../../path";
import { isValidXml } from "../core/xml";
import { parseSyncCollection, syncMultistatus } from "./xml";

export const rfc6578 = new Hono<Env>();

rfc6578.on("REPORT", "*", async (c) => {
  const path = c.get("path");
  if (c.req.header("depth") !== "0") return c.text("Invalid Depth header", 400);
  const body = await c.req.text();
  if (!isValidXml(body)) return c.text("Invalid XML", 400);
  const request = parseSyncCollection(body);
  if (request.syncLevel !== "1" && request.syncLevel !== "infinite")
    return c.text("Invalid sync-level", 400);
  const dav = c.get("dav");
  const result = await dav.sync.sync(path, {
    ...(request.syncToken ? { syncToken: request.syncToken as SyncToken } : {}),
    syncLevel: request.syncLevel,
  });
  if ("error" in result) return c.body(null, 412);
  const changedItems = result.changes.flatMap((change) =>
    change.kind === "changed"
      ? [{ resource: dav.resource(change.path), info: change.resource }]
      : [],
  );
  const changedPropstats = await dav.properties.propfind(changedItems, {
    kind: "prop",
    names: request.properties,
  });
  let changedIndex = 0;
  const responses = result.changes.map((change) =>
    change.kind === "changed"
      ? {
          href: toHref(change.path, change.resource.kind === "collection"),
          propstats: changedPropstats[changedIndex++],
        }
      : {
          href: toHref(change.path),
          propstats: [],
          status: 404,
        },
  );
  return c.body(syncMultistatus(responses, result.syncToken), 207, {
    "Content-Type": "application/xml; charset=utf-8",
  });
});

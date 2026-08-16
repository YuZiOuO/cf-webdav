import type { DavEnv } from "../core/types";
import { Hono } from "hono";
import { isValidXml } from "../core/xml";
import { mkcolResponse, parseMkcol } from "./xml";

export const rfc5689 = new Hono<DavEnv>();

rfc5689.on("MKCOL", "*", async (c) => {
  const path = c.get("path");
  if (path === "/") return c.text("Collection exists", 405);
  const body = c.req.raw.body ? await c.req.text() : "";
  if (body.trim()) {
    if (!c.req.header("content-type")?.toLowerCase().includes("xml"))
      return c.text("MKCOL body is not supported", 415);
    if (!isValidXml(body)) return c.text("Invalid XML", 400);
    const result = await c.get("dav").mkcol.mkcol(path, parseMkcol(body));
    if ("propstats" in result)
      return c.body(mkcolResponse(result.propstats), 403, {
        "Content-Type": "application/xml; charset=utf-8",
      });
    return c.body(null, 201, { Location: c.req.url, ETag: result.etag });
  }
  const directory = await c.get("dav").tree.mkdir(path);
  return c.body(null, 201, { Location: c.req.url, ETag: directory.etag });
});

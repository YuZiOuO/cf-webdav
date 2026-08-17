import type { DavEnv } from "../types";
import { Hono } from "hono";
import {
  DAV_NAMESPACE,
  isValidXml,
  propertyChildren,
  propertyName,
} from "../core/xml";
import { mkcolResponse, parseMkcol } from "./xml";

export const rfc5689 = new Hono<DavEnv>();

rfc5689.on("MKCOL", "*", async (c) => {
  const path = c.get("path");
  if (path === "/") return c.text("Collection exists", 405);
  const resource = c.get("dav").resource(path);
  const body = c.req.raw.body ? await c.req.text() : "";
  if (body.trim()) {
    if (!c.req.header("content-type")?.toLowerCase().includes("xml"))
      return c.text("MKCOL body is not supported", 415);
    if (!isValidXml(body)) return c.text("Invalid XML", 400);
    const properties = parseMkcol(body);
    const hasInvalidResourceType = properties.some((property) => {
      const { namespaceURI, localName } = propertyName(property.element);
      return (
        namespaceURI === DAV_NAMESPACE &&
        localName === "resourcetype" &&
        propertyChildren(property).some(
          (child) =>
            child.namespaceURI !== DAV_NAMESPACE ||
            child.localName !== "collection",
        )
      );
    });
    if (hasInvalidResourceType)
      return c.body(
        mkcolResponse(
          properties.map((property) => ({
            properties: [property],
            status: 403,
          })),
        ),
        403,
        {
          "Content-Type": "application/xml; charset=utf-8",
        },
      );
    const etag = await resource.createCollection();
    const deadProperties = properties.filter(
      (property) =>
        !c
          .get("dav")
          .properties.isProtectedName(propertyName(property.element)),
    );
    if (deadProperties.length) {
      await c.get("dav").properties.proppatch(
        resource,
        deadProperties.map((property) => ({
          kind: "set" as const,
          property,
        })),
      );
    }
    return c.body(null, 201, {
      Location: c.req.url,
      ETag: etag,
    });
  }
  const etag = await resource.createCollection();
  return c.body(null, 201, {
    Location: c.req.url,
    ETag: etag,
  });
});

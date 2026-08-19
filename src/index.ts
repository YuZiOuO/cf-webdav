import { basicAuth } from "hono/basic-auth";
import { Hono } from "hono";
import { WorkerEntrypoint } from "cloudflare:workers";
import webdav from "./webdav";
import browser from "./browser";

type GatewayBindings = CloudflareBindings & {
  cachedWebDav: Cloudflare.Exports["CachedWebDav"];
};

const content = new Hono<{ Bindings: CloudflareBindings }>();
content.use("*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control"))
    c.res.headers.set("Cache-Control", "no-store");
});
content.route("/", browser);
content.route("/", webdav);

const gateway = new Hono<{ Bindings: GatewayBindings }>();
gateway.use("*", (c, next) =>
  basicAuth({
    username: c.env.USERNAME,
    password: c.env.PASSWORD,
  })(c, next),
);
gateway.all("*", async (c) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    const headers = new Headers(c.req.raw.headers);
    headers.delete("Authorization");
    return c.env.cachedWebDav.fetch(c.req.raw, { headers });
  }

  const response = await content.fetch(c.req.raw, c.env, c.executionCtx);
  if (response.ok) {
    const pathPrefixes = cachePathPrefixes(c.req.raw);
    if (pathPrefixes) await c.env.cachedWebDav.purge(pathPrefixes);
  }
  return response;
});

const cachePathPrefixes = (request: Request): string[] | undefined => {
  const path = new URL(request.url).pathname;
  switch (request.method) {
    case "PUT":
    case "DELETE":
      return [path];
    case "COPY":
    case "MOVE": {
      const destination = request.headers.get("Destination");
      if (!destination) return undefined;
      const destinationPath = new URL(destination, request.url).pathname;
      return request.method === "MOVE"
        ? [path, destinationPath]
        : [destinationPath];
    }
    default:
      return undefined;
  }
};

export { FileSystemState } from "./filesystem";
export { WebDavState } from "./webdav";

export class CachedWebDav extends WorkerEntrypoint<CloudflareBindings> {
  async fetch(request: Request): Promise<Response> {
    return content.fetch(request, this.env, this.ctx);
  }

  async purge(pathPrefixes: string[]): Promise<void> {
    if (!this.ctx.cache) return;

    try {
      const result = await this.ctx.cache.purge({ pathPrefixes });
      if (!result.success)
        console.error("Failed to purge Workers Cache", result.errors);
    } catch (error) {
      console.error("Failed to purge Workers Cache", error);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    return gateway.fetch(
      request,
      {
        ...env,
        cachedWebDav: ctx.exports.CachedWebDav,
      },
      ctx,
    );
  },
} satisfies ExportedHandler<CloudflareBindings>;

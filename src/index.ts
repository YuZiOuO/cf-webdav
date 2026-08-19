import { basicAuth } from "hono/basic-auth";
import { Hono } from "hono";
import { WorkerEntrypoint } from "cloudflare:workers";
import webdav from "./webdav";
import browser from "./browser";

// The application layer contains the actual browser and WebDAV routes.
// It has no authentication or cache-routing policy of its own.
const app = new Hono<{ Bindings: CloudflareBindings }>();
app.use("*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control"))
    c.res.headers.set("Cache-Control", "no-store");
});
app.route("/", browser);
app.route("/", webdav);

// Internal named export used by the gateway and by Wrangler's cache-enabled
// App entry. It exposes application requests and cache invalidation only.
export class App extends WorkerEntrypoint<CloudflareBindings> {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
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

// The public gateway owns authentication and decides whether a request goes
// through the cache-enabled App export or directly to the application layer.
const gateway = new Hono<{
  Bindings: CloudflareBindings;
  Variables: { app: Cloudflare.Exports["App"] };
}>();
gateway.use("*", (c, next) => {
  c.set("app", c.executionCtx.exports.App);
  return basicAuth({
    username: c.env.USERNAME,
    password: c.env.PASSWORD,
  })(c, next);
});
gateway.all("*", async (c) => {
  const appExport = c.get("app");
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    const headers = new Headers(c.req.raw.headers);
    headers.delete("Authorization");
    return appExport.fetch(c.req.raw, { headers });
  }

  const response = await app.fetch(c.req.raw, c.env, c.executionCtx);
  if (response.ok) {
    const path = new URL(c.req.url).pathname;
    const pathPrefixes = (() => {
      switch (c.req.method) {
        case "PUT":
        case "DELETE":
          return [path];
        case "COPY":
        case "MOVE": {
          const destination = c.req.header("destination");
          if (!destination) return undefined;
          const destinationPath = new URL(destination, c.req.url).pathname;
          return c.req.method === "MOVE"
            ? [path, destinationPath]
            : [destinationPath];
        }
        default:
          return undefined;
      }
    })();
    if (pathPrefixes) await appExport.purge(pathPrefixes);
  }
  return response;
});

export { FileSystemState } from "./filesystem";
export { WebDavState } from "./webdav";

// The default Worker is the only public HTTP entry point.
export default {
  fetch: (request, env, ctx) => gateway.fetch(request, env, ctx),
} satisfies ExportedHandler<CloudflareBindings>;

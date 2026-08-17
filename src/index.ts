import { basicAuth } from "hono/basic-auth";
import { Hono } from "hono";
import webdav from "./webdav";
import browser from "./browser";

const app = new Hono<{ Bindings: CloudflareBindings }>();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
app.use("*", (c, next) =>
  basicAuth({
    username: c.env.USERNAME,
    password: c.env.PASSWORD,
  })(c, next),
);
app.route("/", browser);
app.route("/", webdav);

export { FileSystemState } from "./filesystem";
export { WebDavState } from "./webdav";

export default {
  async fetch(request, env, ctx) {
    const response = await app.fetch(request, env, ctx);
    if (!response.ok || !ctx.cache) return response;

    const path = new URL(request.url).pathname;
    let pathPrefixes: string[] | undefined;
    switch (request.method) {
      case "PUT":
      case "DELETE":
        pathPrefixes = [path];
        break;
      case "COPY":
      case "MOVE": {
        const destination = request.headers.get("Destination");
        if (!destination) return response;
        const destinationPath = new URL(destination, request.url).pathname;
        pathPrefixes =
          request.method === "MOVE"
            ? [path, destinationPath]
            : [destinationPath];
        break;
      }
    }
    if (!pathPrefixes) return response;

    try {
      const result = await ctx.cache.purge({ pathPrefixes });
      if (!result.success)
        console.error("Failed to purge Workers Cache", result.errors);
    } catch (error) {
      console.error("Failed to purge Workers Cache", error);
    }
    return response;
  },
} satisfies ExportedHandler<CloudflareBindings>;

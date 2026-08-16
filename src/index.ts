import { basicAuth } from "hono/basic-auth";
import { Hono } from "hono";
import webdav from "./webdav";

const app = new Hono<{ Bindings: CloudflareBindings }>();
app.use("*", (c, next) =>
  basicAuth({
    username: c.env.WEBDAV_USERNAME,
    password: c.env.WEBDAV_PASSWORD,
  })(c, next),
);
app.route("/", webdav);

export { FileSystemState } from "./filesystem/meta";
export { WebDavState } from "./webdav/core/state";
export default app;

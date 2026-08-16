import { basicAuth } from "hono/basic-auth";
import { Hono } from "hono";
import webdav from "./webdav";
import browser from "./browser";

const app = new Hono<{ Bindings: CloudflareBindings }>();
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
export default app;

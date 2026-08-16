import { dirname, join } from "node:path/posix";
import { Hono } from "hono";
import { html } from "hono/html";
import { ObjectStoreFileSystem, R2ObjectStore } from "../filesystem";
import type { FileSystem, Path } from "../interfaces";
import { decodePath, toHref } from "../path";

const browser = new Hono<{ Bindings: CloudflareBindings }>();

browser.get("*", async (c, next) => {
  let path: Path;
  let filesystem: FileSystem;
  try {
    path = decodePath(new URL(c.req.url).pathname);
    filesystem = new ObjectStoreFileSystem(
      new R2ObjectStore(c.env.BUCKET),
      c.env.FileSystemState.getByName("root"),
    );
  } catch {
    return c.text("Invalid path", 400);
  }
  const resource = await filesystem.stat(path);
  if (!resource || resource.kind !== "directory") return next();

  const children: { name: string; path: Path; directory: boolean }[] = [];
  for await (const entry of filesystem.readdir(path))
    children.push({
      name: entry.name,
      path: join(path, entry.name),
      directory: entry.resource.kind === "directory",
    });

  const title = toHref(path, true);
  const parent = path === "/" ? undefined : dirname(path);
  const rows = [
    ...(parent ? [html`<a href="${toHref(parent, true)}">../</a><br />`] : []),
    ...children.map(
      (entry) =>
        html`<a href="${toHref(entry.path, entry.directory)}"
            >${entry.name}${entry.directory ? "/" : ""}</a
          ><br />`,
    ),
  ];

  return c.html(html`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Index of ${title}</title>
      </head>
      <body>
        <h1>Index of ${title}</h1>
        <hr />
        <pre>${rows}</pre>
        <hr />
      </body>
    </html>
  `);
});

export default browser;

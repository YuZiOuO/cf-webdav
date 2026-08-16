import { normalize } from "node:path/posix";
import type { Path } from "../../interfaces";

export const decodeWebDavPath = (pathname: string): Path => {
  const decodedPath = decodeURIComponent(pathname);
  if (decodedPath.includes("\0") || decodedPath.split("/").includes(".."))
    throw new Error("Invalid path");
  return normalize(`/${decodedPath}`).replace(/\/+$/, "") || "/";
};

export const toHref = (path: Path, directory = false) =>
  path === "/"
    ? "/"
    : `/${path
        .slice(1)
        .split("/")
        .map(encodeURIComponent)
        .join("/")}${directory ? "/" : ""}`;

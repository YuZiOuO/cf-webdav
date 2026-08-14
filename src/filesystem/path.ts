import { FileSystemError } from "./errors";
import type { Path } from "../interfaces/file_system";

export const toPath = (value: string): Path => {
  if (value.includes("\0"))
    throw new FileSystemError("invalid-path", "Invalid path");

  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..")
      throw new FileSystemError("invalid-path", "Invalid path");
    segments.push(segment);
  }
  return `/${segments.join("/")}` as Path;
};

export const parent = (path: string) => {
  if (path === "/") return path;
  const index = path.lastIndexOf("/");
  return index ? path.slice(0, index) : "/";
};

export const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export const isDescendant = (path: string, ancestor: string) =>
  ancestor === "/" ? path !== "/" : path.startsWith(`${ancestor}/`);

export const remap = (source: string, destination: string, path: string) =>
  path === source
    ? destination
    : `${destination}/${path.slice(source.length + 1)}`;

export const href = (path: string, directory: boolean) =>
  path === "/"
    ? "/"
    : `/${path.slice(1).split("/").map(encodeURIComponent).join("/")}${directory ? "/" : ""}`;

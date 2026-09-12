import { basename } from "node:path/posix";
import { FileSystemError } from "../errors";
import type {
  ByteRange,
  DirectoryEntry,
  FileNode,
  FileContent,
  ObjectKey,
  Path,
} from "../../interfaces";
import { toNode } from "./helper";
import { unwrapState } from "../meta";
import type { FileSystemDependencies } from "./helper";

export const stat = async (deps: FileSystemDependencies, path: Path) => {
  const stored = unwrapState(await deps.state.readNode(path));
  return stored ? toNode(stored) : undefined;
};

export const readFile = async (
  deps: FileSystemDependencies,
  path: Path,
  options?: { range?: ByteRange },
): Promise<FileContent> => {
  const stored = unwrapState(await deps.state.readNode(path));
  if (!stored) throw new FileSystemError("not-found", "Resource not found");
  if (stored.kind !== "file")
    throw new FileSystemError("not-file", "Resource is a directory");

  const file = toNode(stored) as FileNode;

  let range: ByteRange | undefined;
  if (options?.range) {
    const end = Math.min(options.range.end ?? file.size - 1, file.size - 1);
    if (
      options.range.start < 0 ||
      options.range.start >= file.size ||
      end < options.range.start
    )
      throw new FileSystemError(
        "range-not-satisfiable",
        "Requested range is not satisfiable",
      );
    range = { start: options.range.start, end };
  }

  const object = await deps.objects.get(stored.objectKey as ObjectKey, {
    ...(range ? { range } : {}),
  });
  if (!object)
    throw new FileSystemError(
      "inconsistent",
      "File content is missing from object storage",
    );
  return { file, body: object.body, ...(range ? { range } : {}) };
};

export const readdir = async function* (
  deps: FileSystemDependencies,
  path: Path,
): AsyncIterable<DirectoryEntry> {
  for (const stored of unwrapState(await deps.state.readDirectory(path))) {
    yield { name: basename(stored.path), node: toNode(stored) };
  }
};

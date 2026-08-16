import { FileSystemError } from "../../errors";
import type {
  DirectoryEntry,
  File,
  FileContent,
  Path,
  ReadFileOptions,
} from "../../../interfaces/file_system";
import type { ByteRange, ObjectKey } from "../../../interfaces/object_store";
import { name } from "../path";
import { emptyBody } from "../helper";
import { toResource } from "../resource";
import { unwrapState } from "../../meta/helper";
import type { FileSystemDependencies } from "../helper";

export const stat = async (deps: FileSystemDependencies, path: Path) => {
  const stored = unwrapState(await deps.state.readResource(path));
  return stored ? toResource(stored) : undefined;
};

export const readFile = async (
  deps: FileSystemDependencies,
  path: Path,
  options?: ReadFileOptions,
): Promise<FileContent> => {
  const stored = unwrapState(
    await deps.state.readResource(path, options?.preconditions),
  );
  if (!stored) throw new FileSystemError("not-found", "Resource not found");
  if (stored.kind !== "file")
    throw new FileSystemError("not-file", "Resource is a directory");

  const file = toResource(stored) as File;

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

  if (!stored.objectKey) return { file, body: emptyBody() };

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
    yield { name: name(stored.path), resource: toResource(stored) };
  }
};

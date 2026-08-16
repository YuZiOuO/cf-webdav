import { FileSystemError } from "../../errors";
import type {
  Directory,
  File,
  FileData,
  Path,
  ResourceId,
  WriteFileOptions,
} from "../../../interfaces/file_system";
import type { ObjectKey } from "../../../interfaces/object_store";
import { objectKey } from "../helper";
import { resourceId, toResource } from "../resource";
import { unwrapState } from "../../meta/helper";
import type { StateResult, StoredFile } from "../../meta";
import type { FileSystemDependencies } from "../helper";

export const writeFile = async (
  deps: FileSystemDependencies,
  path: Path,
  data: FileData,
  options?: WriteFileOptions,
) => {
  const existing = unwrapState(await deps.state.readResource(path));
  if (existing?.kind === "directory")
    throw new FileSystemError("already-exists", "Directory already exists");

  const id = (existing?.id as ResourceId | undefined) ?? resourceId();
  const key = objectKey(id);
  const stored = await deps.objects.put(key, data);
  let result: StateResult<{
    resource: StoredFile;
    replacedObjectKey?: string;
  }>;

  try {
    result = await deps.state.writeFile(
      path,
      {
        id,
        objectKey: key,
        size: stored.size,
        ...(data.contentType ? { contentType: data.contentType } : {}),
      },
      options?.preconditions,
    );
  } catch (error) {
    await deps.objects.delete(key);
    throw error;
  }

  const written = unwrapState(result);
  if (written.replacedObjectKey) {
    try {
      await deps.objects.delete(written.replacedObjectKey as ObjectKey);
    } catch (error) {
      console.error("Unable to delete replaced object", error);
    }
  }
  return toResource(written.resource) as File;
};

export const mkdir = async (deps: FileSystemDependencies, path: Path) => {
  return toResource(
    unwrapState(await deps.state.createDirectory(path)),
  ) as Directory;
};

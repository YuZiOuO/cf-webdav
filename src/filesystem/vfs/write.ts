import { FileSystemError } from "../errors";
import type {
  Directory,
  File,
  FileData,
  Path,
  ResourceId,
} from "../../interfaces";
import {
  deleteReleasedObjects,
  objectKey,
  resourceId,
  toResource,
} from "./helper";
import { unwrapState } from "../meta";
import type { StoredFile } from "../meta";
import type { FileSystemDependencies } from "./helper";

export const writeFile = async (
  deps: FileSystemDependencies,
  path: Path,
  data: FileData,
) => {
  const existing = unwrapState(await deps.state.readResource(path));
  if (existing?.kind === "directory")
    throw new FileSystemError("already-exists", "Directory already exists");

  const id = (existing?.id as ResourceId | undefined) ?? resourceId();
  const key = objectKey();
  const stored = await deps.objects.put(key, data);

  let written: { resource: StoredFile; releasedObjectKeys: string[] };
  try {
    written = unwrapState(
      await deps.state.writeFile(path, {
        id,
        objectKey: key,
        size: stored.size,
        ...(data.contentType ? { contentType: data.contentType } : {}),
      }),
    );
  } catch (error) {
    await deleteReleasedObjects(deps.objects, [key]);
    throw error;
  }

  await deleteReleasedObjects(deps.objects, written.releasedObjectKeys);
  return toResource(written.resource) as File;
};

export const mkdir = async (deps: FileSystemDependencies, path: Path) => {
  return toResource(
    unwrapState(await deps.state.createDirectory(path)),
  ) as Directory;
};

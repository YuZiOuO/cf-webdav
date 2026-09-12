import { FileSystemError } from "../errors";
import type { DirectoryNode, FileNode, Path } from "../../interfaces";
import { deleteReleasedObjects, objectKey, nodeId, toNode } from "./helper";
import { unwrapState } from "../meta";
import type { StoredFile } from "../meta";
import type { FileSystemDependencies } from "./helper";

export const writeFile = async (
  deps: FileSystemDependencies,
  path: Path,
  body: ReadableStream<Uint8Array>,
) => {
  const existing = unwrapState(await deps.state.readNode(path));
  if (existing?.kind === "directory")
    throw new FileSystemError("already-exists", "Directory already exists");

  const id = existing?.id ?? nodeId();
  const key = objectKey();
  const stored = await deps.objects.put(key, body);

  let written: { node: StoredFile; releasedObjectKeys: string[] };
  try {
    written = unwrapState(
      await deps.state.writeFile(path, {
        id,
        objectKey: key,
        size: stored.size,
      }),
    );
  } catch (error) {
    await deleteReleasedObjects(deps.objects, [key]);
    throw error;
  }

  await deleteReleasedObjects(deps.objects, written.releasedObjectKeys);
  return toNode(written.node) as FileNode;
};

export const mkdir = async (deps: FileSystemDependencies, path: Path) => {
  return toNode(
    unwrapState(await deps.state.createDirectory(path)),
  ) as DirectoryNode;
};

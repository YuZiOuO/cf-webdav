import { FileSystemError } from "../../errors";
import type { Path, RemoveOptions } from "../../../interfaces/file_system";
import { unwrapState } from "../../meta/helper";
import { deleteReleasedObjects } from "../helper";
import type { FileSystemDependencies } from "../helper";

export const remove = async (
  deps: FileSystemDependencies,
  path: Path,
  options?: RemoveOptions,
) => {
  if (path === "/")
    throw new FileSystemError("invalid-path", "Cannot delete root directory");
  const removed = unwrapState(
    await deps.state.removeResource(path, options?.recursive ?? false),
  );
  await deleteReleasedObjects(deps.objects, removed.releasedObjectKeys);
};

import { FileSystemError } from "../../errors";
import type { Path, RemoveOptions } from "../../../interfaces/file_system";
import type { ObjectKey } from "../../../interfaces/object_store";
import { unwrapState } from "../../meta/helper";
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
  try {
    for (const stored of removed) {
      if (stored.kind === "file" && stored.objectKey)
        await deps.objects.delete(stored.objectKey as ObjectKey);
    }
  } catch (error) {
    throw new FileSystemError(
      "inconsistent",
      "Filesystem metadata was removed before object deletion completed",
      { cause: error },
    );
  }
};

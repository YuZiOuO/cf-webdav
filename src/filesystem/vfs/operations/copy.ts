import { FileSystemError } from "../../errors";
import type { CopyOptions, Path } from "../../../interfaces/file_system";
import { toResource } from "../resource";
import { unwrapState } from "../../meta/helper";
import { deleteReleasedObjects } from "../helper";
import type { FileSystemDependencies } from "../helper";

export const copy = async (
  deps: FileSystemDependencies,
  source: Path,
  destination: Path,
  options: CopyOptions,
) => {
  if (source === "/" || destination === "/")
    throw new FileSystemError("invalid-path", "Invalid source or destination");
  const copied = unwrapState(
    await deps.state.copyResource(
      source,
      destination,
      options.recursive,
      options.overwrite,
    ),
  );
  await deleteReleasedObjects(deps.objects, copied.releasedObjectKeys);
  return toResource(copied.resource);
};

import { FileSystemError } from "../../errors";
import type { MoveOptions, Path } from "../../../interfaces/file_system";
import { isDescendant } from "../path";
import { toResource } from "../resource";
import { unwrapState } from "../../meta/helper";
import { deleteReleasedObjects } from "../helper";
import type { FileSystemDependencies } from "../helper";

export const move = async (
  deps: FileSystemDependencies,
  source: Path,
  destination: Path,
  options: MoveOptions,
) => {
  if (
    source === "/" ||
    destination === "/" ||
    isDescendant(destination, source)
  )
    throw new FileSystemError("invalid-path", "Invalid source or destination");
  const moved = unwrapState(
    await deps.state.moveResource(source, destination, options.overwrite),
  );
  await deleteReleasedObjects(deps.objects, moved.releasedObjectKeys);
  return toResource(moved.resource);
};

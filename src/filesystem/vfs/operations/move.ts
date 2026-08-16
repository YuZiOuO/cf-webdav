import { FileSystemError } from "../../errors";
import type { MoveOptions, Path } from "../../../interfaces/file_system";
import type { ObjectKey } from "../../../interfaces/object_store";
import { isDescendant } from "../path";
import { toResource } from "../resource";
import { unwrapState } from "../../meta/helper";
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
  for (const stored of moved.replaced) {
    if (stored.kind === "file" && stored.objectKey) {
      try {
        await deps.objects.delete(stored.objectKey as ObjectKey);
      } catch (error) {
        console.error("Unable to delete replaced object", error);
      }
    }
  }
  return toResource(moved.resource);
};

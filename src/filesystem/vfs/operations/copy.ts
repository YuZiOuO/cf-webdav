import { FileSystemError } from "../../errors";
import type { CopyOptions, Path } from "../../../interfaces/file_system";
import type { ObjectKey } from "../../../interfaces/object_store";
import { remap } from "../path";
import { objectKey } from "../helper";
import { resourceId, toResource } from "../resource";
import { unwrapState } from "../../meta/helper";
import type { CopyEntry } from "../../meta";
import type { FileSystemDependencies } from "../helper";

export const copy = async (
  deps: FileSystemDependencies,
  source: Path,
  destination: Path,
  options: CopyOptions,
) => {
  if (source === "/" || destination === "/")
    throw new FileSystemError("invalid-path", "Invalid source or destination");
  const plan = unwrapState(
    await deps.state.copyPlan(
      source,
      destination,
      options.recursive,
      options.overwrite,
    ),
  );
  const entries: CopyEntry[] = [];
  const copied: ObjectKey[] = [];
  try {
    for (const stored of plan.source) {
      const path = remap(source, destination, stored.path) as Path;
      const now = Date.now();
      if (stored.kind === "directory") {
        entries.push({
          sourcePath: stored.path,
          resource: {
            path,
            id: resourceId(),
            kind: "directory",
            createdAt: now,
            lastModified: now,
          },
        });
        continue;
      }

      const id = resourceId();
      let objectKeyForCopy: ObjectKey | undefined;
      let size = stored.size;
      if (stored.objectKey) {
        const sourceObject = await deps.objects.get(
          stored.objectKey as ObjectKey,
        );
        if (!sourceObject)
          throw new FileSystemError(
            "inconsistent",
            "Source content is missing from object storage",
          );
        objectKeyForCopy = objectKey(id);
        copied.push(objectKeyForCopy);
        size = (
          await deps.objects.put(objectKeyForCopy, {
            body: sourceObject.body,
            size: stored.size,
            ...(stored.contentType ? { contentType: stored.contentType } : {}),
          })
        ).size;
      }
      entries.push({
        sourcePath: stored.path,
        resource: {
          path,
          id,
          kind: "file",
          createdAt: now,
          lastModified: now,
          size,
          ...(stored.contentType ? { contentType: stored.contentType } : {}),
          ...(objectKeyForCopy ? { objectKey: objectKeyForCopy } : {}),
        },
      });
    }

    const committed = unwrapState(
      await deps.state.commitCopy(
        source,
        destination,
        options.recursive,
        options.overwrite,
        entries,
      ),
    );
    for (const stored of committed.replaced) {
      if (stored.kind === "file" && stored.objectKey) {
        try {
          await deps.objects.delete(stored.objectKey as ObjectKey);
        } catch (error) {
          console.error("Unable to delete replaced object", error);
        }
      }
    }
    return toResource(committed.resource);
  } catch (error) {
    for (const key of copied) {
      try {
        await deps.objects.delete(key);
      } catch (cleanupError) {
        console.error("Unable to remove incomplete copy", cleanupError);
      }
    }
    throw error;
  }
};

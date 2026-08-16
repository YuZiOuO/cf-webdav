import type { ResourceId } from "../../interfaces/file_system";
import type { ObjectKey, ObjectStore } from "../../interfaces/object_store";
import type { FileSystemState } from "../meta";

// Dependencies shared by VFS operations.
export interface FileSystemDependencies {
  objects: ObjectStore;
  state: DurableObjectStub<FileSystemState>;
}

// Object content helpers used when bridging metadata and object storage.
export const objectKey = (id: ResourceId) =>
  `resources/${id}/${crypto.randomUUID()}` as ObjectKey;

export const emptyBody = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

export const deleteReleasedObjects = async (
  objects: ObjectStore,
  objectKeys: readonly string[],
) => {
  for (const key of objectKeys) {
    try {
      await objects.delete(key as ObjectKey);
    } catch (error) {
      console.error("Unable to delete released object", key, error);
    }
  }
};

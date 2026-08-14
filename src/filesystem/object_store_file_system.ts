import { FileSystemError } from "./errors";
import type {
  CopyOptions,
  Directory,
  DirectoryEntry,
  File,
  FileContent,
  FileData,
  FileSystem,
  MoveOptions,
  Path,
  ReadFileOptions,
  RemoveOptions,
  Resource,
  ResourceId,
  StorageQuota,
  StorageQuotaProvider,
  WriteFileOptions,
} from "../interfaces/file_system";
import type {
  ByteRange,
  ObjectKey,
  ObjectStore,
} from "../interfaces/object_store";
import {
  matchesPreconditions,
  newEntityTag,
  unwrapState,
  type CopyEntry,
  type FileSystemState,
  type StateResult,
  type StoredFile,
  type StoredResource,
} from "./state";
import { isDescendant, name, remap } from "./path";

export const resourceId = () => crypto.randomUUID() as ResourceId;

const objectKey = (id: ResourceId) =>
  `resources/${id}/${crypto.randomUUID()}` as ObjectKey;

export const toResource = (stored: StoredResource): Resource => {
  const base = {
    id: stored.id as ResourceId,
    etag: stored.etag,
    createdAt: new Date(stored.createdAt),
    lastModified: new Date(stored.lastModified),
  };
  if (stored.kind === "directory") return { ...base, kind: "directory" };
  return {
    ...base,
    kind: "file",
    size: stored.size,
    ...(stored.contentType ? { contentType: stored.contentType } : {}),
  };
};

export const emptyBody = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

export class ObjectStoreFileSystem implements FileSystem, StorageQuotaProvider {
  constructor(
    private readonly objects: ObjectStore,
    private readonly state: DurableObjectStub<FileSystemState>,
  ) {}

  async stat(path: Path) {
    const stored = await this.state.readResource(path);
    return stored ? toResource(stored) : undefined;
  }

  async readFile(path: Path, options?: ReadFileOptions): Promise<FileContent> {
    const stored = await this.state.readResource(path);
    if (!stored) throw new FileSystemError("not-found", "Resource not found");
    if (stored.kind !== "file")
      throw new FileSystemError("not-file", "Resource is a directory");

    const file = toResource(stored) as File;
    if (!matchesPreconditions(file.etag, options?.preconditions))
      throw new FileSystemError("precondition-failed", "Precondition failed");

    let range: ByteRange | undefined;
    if (options?.range) {
      const end = Math.min(options.range.end ?? file.size - 1, file.size - 1);
      if (
        options.range.start < 0 ||
        options.range.start >= file.size ||
        end < options.range.start
      )
        throw new FileSystemError(
          "range-not-satisfiable",
          "Requested range is not satisfiable",
        );
      range = { start: options.range.start, end };
    }

    if (!stored.objectKey) return { file, body: emptyBody() };

    const object = await this.objects.get(stored.objectKey as ObjectKey, {
      ...(range ? { range } : {}),
    });
    if (!object)
      throw new FileSystemError(
        "inconsistent",
        "File content is missing from object storage",
      );
    return { file, body: object.body, ...(range ? { range } : {}) };
  }

  async *readdir(path: Path): AsyncIterable<DirectoryEntry> {
    for (const stored of unwrapState(await this.state.readDirectory(path))) {
      yield { name: name(stored.path), resource: toResource(stored) };
    }
  }

  async writeFile(path: Path, data: FileData, options?: WriteFileOptions) {
    const existing = await this.state.readResource(path);
    if (existing?.kind === "directory")
      throw new FileSystemError("already-exists", "Directory already exists");

    const id = (existing?.id as ResourceId | undefined) ?? resourceId();
    const key = objectKey(id);
    const stored = await this.objects.put(key, data);
    let result: StateResult<{
      resource: StoredFile;
      replacedObjectKey?: string;
    }>;
    try {
      result = await this.state.writeFile(
        path,
        {
          id,
          etag: newEntityTag(),
          objectKey: key,
          size: stored.size,
          ...(data.contentType ? { contentType: data.contentType } : {}),
        },
        options?.preconditions,
      );
    } catch (error) {
      await this.objects.delete(key);
      throw error;
    }

    const written = unwrapState(result);
    if (written.replacedObjectKey) {
      try {
        await this.objects.delete(written.replacedObjectKey as ObjectKey);
      } catch (error) {
        console.error("Unable to delete replaced object", error);
      }
    }
    return toResource(written.resource) as File;
  }

  async mkdir(path: Path) {
    return toResource(
      unwrapState(
        await this.state.createDirectory(path, {
          id: resourceId(),
          etag: newEntityTag(),
        }),
      ),
    ) as Directory;
  }

  async remove(path: Path, options?: RemoveOptions) {
    if (path === "/")
      throw new FileSystemError("invalid-path", "Cannot delete root directory");
    const removed = unwrapState(
      await this.state.removeResource(path, options?.recursive ?? false),
    );
    try {
      for (const stored of removed) {
        if (stored.kind === "file" && stored.objectKey)
          await this.objects.delete(stored.objectKey as ObjectKey);
      }
    } catch (error) {
      throw new FileSystemError(
        "inconsistent",
        "Filesystem metadata was removed before object deletion completed",
        { cause: error },
      );
    }
  }

  async copy(source: Path, destination: Path, options: CopyOptions) {
    if (source === "/" || destination === "/")
      throw new FileSystemError(
        "invalid-path",
        "Invalid source or destination",
      );
    const plan = unwrapState(
      await this.state.copyPlan(
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
              etag: newEntityTag(),
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
          const sourceObject = await this.objects.get(
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
            await this.objects.put(objectKeyForCopy, {
              body: sourceObject.body,
              size: stored.size,
              ...(stored.contentType
                ? { contentType: stored.contentType }
                : {}),
            })
          ).size;
        }
        entries.push({
          sourcePath: stored.path,
          resource: {
            path,
            id,
            kind: "file",
            etag: newEntityTag(),
            createdAt: now,
            lastModified: now,
            size,
            ...(stored.contentType ? { contentType: stored.contentType } : {}),
            ...(objectKeyForCopy ? { objectKey: objectKeyForCopy } : {}),
          },
        });
      }

      const committed = unwrapState(
        await this.state.commitCopy(
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
            await this.objects.delete(stored.objectKey as ObjectKey);
          } catch (error) {
            console.error("Unable to delete replaced object", error);
          }
        }
      }
      return toResource(committed.resource);
    } catch (error) {
      for (const key of copied) {
        try {
          await this.objects.delete(key);
        } catch (cleanupError) {
          console.error("Unable to remove incomplete copy", cleanupError);
        }
      }
      throw error;
    }
  }

  async move(source: Path, destination: Path, options: MoveOptions) {
    if (
      source === "/" ||
      destination === "/" ||
      isDescendant(destination, source)
    )
      throw new FileSystemError(
        "invalid-path",
        "Invalid source or destination",
      );
    const moved = unwrapState(
      await this.state.moveResource(source, destination, options.overwrite),
    );
    for (const stored of moved.replaced) {
      if (stored.kind === "file" && stored.objectKey) {
        try {
          await this.objects.delete(stored.objectKey as ObjectKey);
        } catch (error) {
          console.error("Unable to delete replaced object", error);
        }
      }
    }
    return toResource(moved.resource);
  }

  async getQuota(path: Path): Promise<StorageQuota> {
    return { usedBytes: await this.state.usedBytes(path) };
  }
}

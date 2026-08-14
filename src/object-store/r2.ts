import type {
  EntityTag,
  GetObjectOptions,
  ObjectData,
  ObjectKey,
  ObjectMetadata,
  ObjectStore,
} from "../interfaces/object_store";

const toMetadata = (object: R2Object): ObjectMetadata => ({
  etag: object.httpEtag as EntityTag,
  size: object.size,
  lastModified: object.uploaded,
  ...(object.httpMetadata?.contentType
    ? { contentType: object.httpMetadata.contentType }
    : {}),
});

export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

  async head(key: ObjectKey) {
    const object = await this.bucket.head(key);
    return object ? toMetadata(object) : undefined;
  }

  async get(key: ObjectKey, options?: GetObjectOptions) {
    const range = options?.range;
    const object = await this.bucket.get(
      key,
      range
        ? {
            range: {
              offset: range.start,
              ...(range.end === undefined
                ? {}
                : { length: range.end - range.start + 1 }),
            },
          }
        : {},
    );
    if (!object || !("body" in object)) return;
    return {
      ...toMetadata(object),
      body: object.body as ReadableStream<Uint8Array>,
    };
  }

  async put(key: ObjectKey, data: ObjectData) {
    return toMetadata(
      await this.bucket.put(
        key,
        data.body,
        data.contentType
          ? { httpMetadata: { contentType: data.contentType } }
          : {},
      ),
    );
  }

  delete(key: ObjectKey) {
    return this.bucket.delete(key);
  }
}

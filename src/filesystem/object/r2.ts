import type { ObjectKey, ObjectStore } from "../../interfaces";

export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

  async get(
    key: ObjectKey,
    options?: { range?: { start: number; end?: number } },
  ) {
    const range = options?.range;
    if (!range) {
      const object = await this.bucket.get(key);
      return object ? { body: object.body } : undefined;
    }
    const object = await this.bucket.get(key, {
      range: {
        offset: range.start,
        ...(range.end === undefined
          ? {}
          : { length: range.end - range.start + 1 }),
      },
    });
    return object ? { body: object.body } : undefined;
  }

  async put(key: ObjectKey, body: ReadableStream<Uint8Array>) {
    const object = await this.bucket.put(key, body, {});
    return { size: object.size };
  }

  delete(key: ObjectKey) {
    return this.bucket.delete(key);
  }
}

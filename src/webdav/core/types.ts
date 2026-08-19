/** A decoded absolute URL path used inside the WebDAV implementation. */
export type Path = string;

/** An XML expanded name: namespace URI plus local name. */
export interface PropertyName {
  namespaceURI: string;
  localName: string;
}

/** A WebDAV property represented by its complete XML element. */
export interface Property {
  element: Element;
}

export type EntityTag = `"${string}"` | `W/"${string}"`;

export type LockScope = "exclusive" | "shared";
export type LockDepth = "0" | "infinity";

export interface ByteRange {
  start: number;
  end?: number;
}

export interface FileInfo {
  kind: "file";
  lastModified: Date;
  contentLength: number;
  contentType?: string;
}

export type ResourceInfo =
  | FileInfo
  | {
      kind: "collection";
      lastModified: Date;
    };

export interface FileData {
  body: ReadableStream<Uint8Array>;
  contentLength: number;
  contentType?: string;
}

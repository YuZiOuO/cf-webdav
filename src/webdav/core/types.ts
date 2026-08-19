/** A decoded absolute URL path used inside the WebDAV implementation. */
export type DavPath = string;

/** An XML expanded name: namespace URI plus local name. */
export interface DavPropertyName {
  namespaceURI: string;
  localName: string;
}

/** A WebDAV property represented by its complete XML element. */
export interface DavProperty {
  element: Element;
}

export type EntityTag = `"${string}"` | `W/"${string}"`;

export type LockScope = "exclusive" | "shared";
export type LockDepth = "0" | "infinity";

export interface DavByteRange {
  start: number;
  end?: number;
}

export interface DavFile {
  kind: "file";
  lastModified: Date;
  contentLength: number;
  contentType?: string;
}

export interface DavCollection {
  kind: "collection";
  lastModified: Date;
}

export type DavResourceInfo = DavFile | DavCollection;

export interface DavFileContent {
  file: DavFile;
  body: ReadableStream<Uint8Array>;
  range?: DavByteRange;
}

export interface DavFileData {
  body: ReadableStream<Uint8Array>;
  contentLength: number;
  contentType?: string;
}

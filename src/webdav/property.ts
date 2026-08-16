import type {
  DavProperty,
  DavPropertyName,
  DavProppatchInstruction,
} from "../interfaces/webdav/rfc4918";
import {
  DAV_NAMESPACE,
  createPropertyElement,
  propertyName,
  serializeProperty,
} from "./xml";
import type { StoredProperty } from "../filesystem/meta";

export const propertyKey = ({ namespaceURI, localName }: DavPropertyName) =>
  `${namespaceURI}\0${localName}`;

export const protectedPropertyNames = new Set(
  [
    "getetag",
    "getcontentlength",
    "getlastmodified",
    "resourcetype",
    "supportedlock",
    "sync-token",
    "supported-report-set",
    "quota-available-bytes",
    "quota-used-bytes",
  ].map((localName) => propertyKey({ namespaceURI: DAV_NAMESPACE, localName })),
);

export const storedProperty = (property: DavProperty): StoredProperty => {
  const { namespaceURI, localName } = propertyName(property.element);
  return {
    namespaceURI,
    localName,
    xml: serializeProperty(property),
  };
};

export const instructionProperty = (
  instruction: DavProppatchInstruction,
): DavProperty =>
  instruction.kind === "set"
    ? instruction.property
    : { element: createPropertyElement(instruction.name) };

export const isProtectedInstruction = (instruction: DavProppatchInstruction) =>
  protectedPropertyNames.has(
    propertyKey(
      instruction.kind === "set"
        ? propertyName(instruction.property.element)
        : instruction.name,
    ),
  );

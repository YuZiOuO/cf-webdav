import {
  DOMImplementation,
  DOMParser,
  XMLSerializer,
  type Element as XmlElement,
} from "@xmldom/xmldom";
import { XMLValidator } from "fast-xml-parser";
import type { Property, PropertyName } from "./types";

export const DAV_NAMESPACE = "DAV:";

type DomElement = Element;

const serializer = new XMLSerializer();

const xmlElement = (element: DomElement) => element as unknown as XmlElement;

const davElement = (element: XmlElement) => element as unknown as DomElement;

export const elementChildren = (parent: XmlElement) =>
  Array.from(parent.childNodes).filter(
    (node): node is XmlElement => node.nodeType === 1,
  );

export const elementLocalName = (element: XmlElement) =>
  element.localName ?? element.nodeName.split(":").pop()!;

const propertyElement = (name: PropertyName) => {
  const prefix = name.namespaceURI === DAV_NAMESPACE ? "D" : "P";
  const document = new DOMImplementation().createDocument(
    name.namespaceURI || null,
    name.namespaceURI ? `${prefix}:${name.localName}` : name.localName,
    null,
  );
  return document.documentElement!;
};

export const isValidXml = (xml: string) =>
  !/\bxmlns:[\w.-]+\s*=\s*(["'])\s*\1/.test(xml) &&
  XMLValidator.validate(xml) === true;

export const appendDavElement = (
  parent: DomElement,
  name: string,
  value?: string,
) => {
  const xmlParent = xmlElement(parent);
  const document = xmlParent.ownerDocument!;
  const element = document.createElementNS(DAV_NAMESPACE, `D:${name}`);
  if (value !== undefined) element.appendChild(document.createTextNode(value));
  xmlParent.appendChild(element);
  return davElement(element);
};

export const propertyName = (element: DomElement): PropertyName => {
  const value = xmlElement(element);
  return {
    namespaceURI: value.namespaceURI ?? "",
    localName: elementLocalName(value),
  };
};

export const propertyChildren = (property: Property) =>
  elementChildren(xmlElement(property.element)).map((element) => ({
    namespaceURI: element.namespaceURI,
    localName: elementLocalName(element),
  }));

export const createPropertyElement = (name: PropertyName) =>
  davElement(propertyElement(name));

export const createDavProperty = (name: string, value?: string) => {
  const property = propertyElement({
    namespaceURI: DAV_NAMESPACE,
    localName: name,
  });
  if (value !== undefined)
    property.appendChild(property.ownerDocument!.createTextNode(value));
  return davElement(property);
};

export const serializeProperty = (property: Property) =>
  serializer.serializeToString(xmlElement(property.element));

export const parseProperty = (xml: string): Property => {
  const root = new DOMParser().parseFromString(
    xml,
    "application/xml",
  ).documentElement;
  if (!root || elementLocalName(root) === "parsererror")
    throw new Error("Invalid XML document");
  return { element: davElement(root) };
};

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DOMParser, type Element } from "@xmldom/xmldom";

export const DAV_NAMESPACE = "DAV:";
export const TEST_NAMESPACE = "urn:cf-r2-webdav:rfc-test";

// RFC test registration
type NormativeLevel = "MUST" | "MUST NOT" | "SHOULD" | "SHOULD NOT" | "MAY";

interface RfcTestMetadata {
  id: string;
  rfc: "4918" | "6578" | "4331" | "5689";
  section: string;
  requirement: NormativeLevel;
  title: string;
  prerequisites: readonly string[];
  request: string;
  assertions: readonly string[];
  alternatives: readonly string[];
}

export function rfcTest(
  metadata: RfcTestMetadata,
  callback: (context: TestContext) => void | Promise<void>,
) {
  void test(
    `[${metadata.id}] RFC ${metadata.rfc} ${metadata.section}: ${metadata.title}`,
    callback,
  );
}

// Local WebDAV server
export class WebDavTestClient {
  private worker: ChildProcess | undefined;
  private stateDirectory: string | undefined;
  private baseUrl: string | undefined;
  private output = "";
  private sequence = 0;

  private readonly root = "/rfc-test";

  get origin() {
    if (!this.baseUrl) throw new Error("The WebDAV test server is not running");
    return this.baseUrl;
  }

  async start() {
    try {
      this.stateDirectory = await mkdtemp(join(tmpdir(), "cf-r2-webdav-rfc-"));
      this.baseUrl = "http://127.0.0.1:8787/";
      const worker = spawn(
        "bunx",
        [
          "wrangler",
          "dev",
          "--persist-to",
          join(this.stateDirectory, "state"),
          "--var",
          "WEBDAV_USERNAME:rfc-test",
          "--var",
          "WEBDAV_PASSWORD:rfc-test",
        ],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      this.worker = worker;
      const appendOutput = (chunk: Buffer) => {
        this.output += chunk.toString();
      };
      worker.stdout.on("data", appendOutput);
      worker.stderr.on("data", appendOutput);

      await this.waitForReady(worker);
      const root = await this.request(this.root, { method: "MKCOL" });
      await assertStatus(root, 201);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    const worker = this.worker;
    this.worker = undefined;
    this.baseUrl = undefined;
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, "exit");
      worker.kill("SIGTERM");
      await Promise.race([exited, delay(5000)]);
      if (worker.exitCode === null && worker.signalCode === null) {
        const exitedAfterKill = once(worker, "exit");
        worker.kill("SIGKILL");
        await exitedAfterKill;
      }
    }
    if (this.stateDirectory) {
      await rm(this.stateDirectory, { force: true, recursive: true });
      this.stateDirectory = undefined;
    }
  }

  url(path: string) {
    return new URL(path, this.origin).toString();
  }

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set(
      "Authorization",
      `Basic ${Buffer.from("rfc-test:rfc-test").toString("base64")}`,
    );
    return fetch(this.url(path), { ...init, headers });
  }

  newPath(label: string) {
    this.sequence += 1;
    return `${this.root}/${label}-${this.sequence}/`;
  }

  createCollection(label: string) {
    return this.createCollectionAt(this.newPath(label));
  }

  async createCollectionAt(path: string) {
    const response = await this.request(path, { method: "MKCOL" });
    await assertStatus(response, 201);
    return path;
  }

  async createFile(collection: string, name: string, body: string) {
    const path = `${collection}${name}`;
    const response = await this.request(path, { method: "PUT", body });
    await assertStatus(response, 201);
    return path;
  }

  private async waitForReady(worker: ChildProcess) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        await this.request("/", { method: "GET" });
        return;
      } catch {
        // The local listener is not available until Wrangler has bundled the Worker.
      }
      if (worker.exitCode !== null || worker.signalCode !== null)
        throw new Error(
          `Wrangler exited before the test server was ready:\n${this.output}`,
        );
      await delay(200);
    }
    throw new Error(
      `Timed out waiting for the WebDAV test server:\n${this.output}`,
    );
  }
}

// HTTP and WebDAV requests
export async function assertStatus(response: Response, expected: number) {
  if (response.status === expected) return;
  const body = await response.clone().text();
  assert.equal(
    response.status,
    expected,
    `${response.status} response body: ${body}`,
  );
}

export const propfindBody = (properties: string) =>
  `<D:propfind xmlns:D="DAV:" xmlns:T="${TEST_NAMESPACE}"><D:prop>${properties}</D:prop></D:propfind>`;

export const proppatchBody = (instructions: string) =>
  `<D:propertyupdate xmlns:D="DAV:" xmlns:T="${TEST_NAMESPACE}">${instructions}</D:propertyupdate>`;

export function propfind(
  client: WebDavTestClient,
  path: string,
  body: string,
  depth = "0",
) {
  return client.request(path, {
    method: "PROPFIND",
    headers: { "Content-Type": "application/xml", Depth: depth },
    body,
  });
}

export function proppatch(
  client: WebDavTestClient,
  path: string,
  body: string,
) {
  return client.request(path, {
    method: "PROPPATCH",
    headers: { "Content-Type": "application/xml" },
    body,
  });
}

// DAV XML parsing
interface DavPropStat {
  properties: readonly Element[];
  status: number;
}

interface DavResponse {
  href: string;
  propstats: readonly DavPropStat[];
  status: number | undefined;
}

interface DavMultiStatus {
  responses: readonly DavResponse[];
  syncToken: string | undefined;
}

export function parseXml(xml: string) {
  const root = new DOMParser().parseFromString(
    xml,
    "application/xml",
  ).documentElement;
  assert.ok(root, "Expected an XML document");
  assert.notEqual(
    root.localName,
    "parsererror",
    `Invalid XML response: ${xml}`,
  );
  return root;
}

export function parseDavMultiStatus(xml: string): DavMultiStatus {
  const root = parseXml(xml);
  assertElement(root, DAV_NAMESPACE, "multistatus");
  const responses = Array.from(root.children)
    .filter((element) => isElement(element, DAV_NAMESPACE, "response"))
    .map((element) => {
      const href = requiredChild(element, DAV_NAMESPACE, "href").textContent;
      assert.ok(href, "A DAV:response requires a non-empty DAV:href");
      const directStatus = childElement(element, DAV_NAMESPACE, "status");
      return {
        href,
        propstats: parseDavPropStats(element),
        status: directStatus
          ? parseHttpStatus(directStatus.textContent ?? "")
          : undefined,
      };
    });
  const syncToken = childElement(
    root,
    DAV_NAMESPACE,
    "sync-token",
  )?.textContent;
  return { responses, syncToken: syncToken || undefined };
}

export function parseDavPropStats(parent: Element): DavPropStat[] {
  return Array.from(parent.children)
    .filter((element) => isElement(element, DAV_NAMESPACE, "propstat"))
    .map((element) => {
      const properties = Array.from(
        requiredChild(element, DAV_NAMESPACE, "prop").children,
      );
      const status = parseHttpStatus(
        requiredChild(element, DAV_NAMESPACE, "status").textContent ?? "",
      );
      return { properties, status };
    });
}

// DAV XML queries and assertions
export const responseForPath = (
  multistatus: DavMultiStatus,
  client: WebDavTestClient,
  path: string,
) => {
  const expected = normalizePath(new URL(path, client.origin));
  const response = multistatus.responses.find(
    (candidate) =>
      normalizePath(new URL(candidate.href, client.origin)) === expected,
  );
  assert.ok(response, `No DAV:response for ${path}`);
  return response;
};

export const propertyStatus = (
  propstats: readonly DavPropStat[],
  namespace: string,
  name: string,
) =>
  propstats.find((propstat) =>
    propstat.properties.some((property) =>
      isElement(property, namespace, name),
    ),
  )?.status;

export const propertyElement = (
  propstats: readonly DavPropStat[],
  namespace: string,
  name: string,
) => {
  for (const propstat of propstats) {
    const property = propstat.properties.find((candidate) =>
      isElement(candidate, namespace, name),
    );
    if (property) return property;
  }
  return undefined;
};

export const requiredProperty = (
  propstats: readonly DavPropStat[],
  namespace: string,
  name: string,
) => {
  const property = propertyElement(propstats, namespace, name);
  assert.ok(property, `Missing property {${namespace}}${name}`);
  return property;
};

export const childElement = (
  parent: Element,
  namespace: string,
  name: string,
) =>
  Array.from(parent.children).find((element) =>
    isElement(element, namespace, name),
  );

export const requiredChild = (
  parent: Element,
  namespace: string,
  name: string,
) => {
  const element = childElement(parent, namespace, name);
  assert.ok(element, `Missing child {${namespace}}${name}`);
  return element;
};

export const assertElement = (
  element: Element,
  namespace: string,
  name: string,
) => {
  assert.equal(element.namespaceURI, namespace);
  assert.equal(element.localName, name);
};

// Internal parsing utilities
const isElement = (element: Element, namespace: string, name: string) =>
  element.namespaceURI === namespace && element.localName === name;

const parseHttpStatus = (value: string) => {
  const match = /\b(\d{3})\b/.exec(value);
  assert.ok(match, `Invalid HTTP status value: ${value}`);
  return Number(match[1]);
};

const normalizePath = (url: URL) => url.pathname.replace(/\/+$/, "") || "/";

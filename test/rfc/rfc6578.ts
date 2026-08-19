import assert from "node:assert/strict";
import {
  DAV_NAMESPACE,
  assertStatus,
  parseDavMultiStatus,
  propfind,
  propfindBody,
  propertyStatus,
  proppatch,
  proppatchBody,
  requiredProperty,
  responseForPath,
  rfcTest,
  type WebDavTestClient,
} from "./support";

export function registerRfc6578Tests(client: WebDavTestClient) {
  rfcTest(
    {
      id: "RFC6578-03.2-001",
      rfc: "6578",
      section: "3.2, 4",
      requirement: "MUST",
      title: "Synchronization support is discoverable on a collection",
      prerequisites: ["A collection exists."],
      request:
        "PROPFIND {collection}; DAV:supported-report-set, DAV:sync-token",
      assertions: [
        "DAV:supported-report-set has status 200 and contains DAV:sync-collection.",
        "DAV:sync-token has status 200 and contains a URI.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("sync-discovery");
      const response = await propfind(
        client,
        collection,
        propfindBody("<D:supported-report-set/><D:sync-token/>"),
      );
      await assertStatus(response, 207);
      const item = responseForPath(
        parseDavMultiStatus(await response.text()),
        client,
        collection,
      );
      assert.equal(
        propertyStatus(item.propstats, DAV_NAMESPACE, "supported-report-set"),
        200,
      );
      const reportSet = requiredProperty(
        item.propstats,
        DAV_NAMESPACE,
        "supported-report-set",
      );
      assert.ok(
        reportSet.getElementsByTagNameNS(DAV_NAMESPACE, "sync-collection")
          .length > 0,
        "DAV:supported-report-set does not list DAV:sync-collection",
      );
      assert.equal(
        propertyStatus(item.propstats, DAV_NAMESPACE, "sync-token"),
        200,
      );
      const token = requiredProperty(
        item.propstats,
        DAV_NAMESPACE,
        "sync-token",
      ).textContent;
      assert.ok(token, "DAV:sync-token is empty");
      assertUri(token);
    },
  );

  rfcTest(
    {
      id: "RFC6578-03.2-002",
      rfc: "6578",
      section: "3.2, 3.3",
      requirement: "MUST",
      title: "sync-collection only accepts Depth 0",
      prerequisites: ["A collection exists."],
      request: "REPORT {collection}; Depth: 1; DAV:sync-collection",
      assertions: ["The response is 400."],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("sync-depth");
      const response = await syncReport(client, collection, "", "1", "1");
      await assertStatus(response, 400);
    },
  );

  rfcTest(
    {
      id: "RFC6578-03.2-003",
      rfc: "6578",
      section: "3.2, 3.3, 3.4",
      requirement: "MUST",
      title: "Initial synchronization reports each immediate member",
      prerequisites: [
        "A collection has immediate file and collection members, plus a nested file.",
      ],
      request:
        "REPORT {collection}; Depth: 0; empty DAV:sync-token; DAV:sync-level 1",
      assertions: [
        "The response is a 207 DAV:multistatus with a URI sync token.",
        "Every immediate member has one response with DAV:propstat and no DAV:status.",
        "The nested file is outside DAV:sync-level 1 and is not reported.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("sync-initial");
      const first = await client.createFile(collection, "first.txt", "first");
      const second = await client.createFile(
        collection,
        "second.txt",
        "second",
      );
      const child = await client.createCollectionAt(`${collection}child/`);
      const nested = await client.createFile(child, "nested.txt", "nested");

      const response = await syncReport(client, collection, "");
      await assertStatus(response, 207);
      const multistatus = parseDavMultiStatus(await response.text());
      assert.ok(
        multistatus.syncToken,
        "Initial synchronization is missing DAV:sync-token",
      );
      assertUri(multistatus.syncToken);
      assertUniqueHrefs(
        multistatus.responses.map((item) => item.href),
        client,
      );
      for (const path of [first, second, child]) {
        const item = responseForPath(multistatus, client, path);
        assert.equal(item.status, undefined);
        assert.ok(item.propstats.length > 0, `No DAV:propstat for ${path}`);
      }
      assert.throws(() => responseForPath(multistatus, client, nested));
    },
  );

  rfcTest(
    {
      id: "RFC6578-03.5-001",
      rfc: "6578",
      section: "3.5.1, 3.5.2",
      requirement: "MUST",
      title:
        "Subsequent synchronization distinguishes changed and removed members",
      prerequisites: ["An initial synchronization token has been obtained."],
      request: "REPORT {collection}; DAV:sync-token from a previous response",
      assertions: [
        "Changed and newly mapped members have DAV:propstat and no DAV:status.",
        "A removed member has DAV:status 404 and no DAV:propstat.",
        "No member URL appears more than once.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("sync-changes");
      const changed = await client.createFile(
        collection,
        "changed.txt",
        "before",
      );
      const removed = await client.createFile(
        collection,
        "removed.txt",
        "remove",
      );
      const initial = await syncReport(client, collection, "");
      await assertStatus(initial, 207);
      const token = parseDavMultiStatus(await initial.text()).syncToken;
      assert.ok(token, "Initial synchronization is missing DAV:sync-token");

      const modified = await client.request(changed, {
        method: "PUT",
        body: "after",
      });
      await assertStatus(modified, 204);
      const deleted = await client.request(removed, { method: "DELETE" });
      await assertStatus(deleted, 204);
      const added = await client.createFile(collection, "added.txt", "added");

      const response = await syncReport(client, collection, token);
      await assertStatus(response, 207);
      const multistatus = parseDavMultiStatus(await response.text());
      assert.ok(
        multistatus.syncToken,
        "Subsequent synchronization is missing DAV:sync-token",
      );
      assertUri(multistatus.syncToken);
      assertUniqueHrefs(
        multistatus.responses.map((item) => item.href),
        client,
      );
      for (const path of [changed, added]) {
        const item = responseForPath(multistatus, client, path);
        assert.equal(item.status, undefined);
        assert.ok(item.propstats.length > 0, `No DAV:propstat for ${path}`);
      }
      const removedItem = responseForPath(multistatus, client, removed);
      assert.equal(removedItem.status, 404);
      assert.equal(removedItem.propstats.length, 0);
    },
  );

  rfcTest(
    {
      id: "RFC6578-04-001",
      rfc: "6578",
      section: "4",
      requirement: "MUST",
      title: "DAV:sync-token cannot be changed by PROPPATCH",
      prerequisites: ["A collection supports DAV:sync-collection."],
      request: "PROPPATCH {collection}; DAV:set(DAV:sync-token)",
      assertions: ["DAV:sync-token is not reported with status 200."],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("sync-protected");
      const response = await proppatch(
        client,
        collection,
        proppatchBody(
          "<D:set><D:prop><D:sync-token>urn:example:changed</D:sync-token></D:prop></D:set>",
        ),
      );
      await assertStatus(response, 207);
      const item = responseForPath(
        parseDavMultiStatus(await response.text()),
        client,
        collection,
      );
      assert.notEqual(
        propertyStatus(item.propstats, DAV_NAMESPACE, "sync-token"),
        200,
      );
    },
  );

  rfcTest(
    {
      id: "RFC6578-05-001",
      rfc: "6578",
      section: "5",
      requirement: "MUST",
      title: "DAV:sync-token is usable as an If state token",
      prerequisites: ["A collection synchronization token has been obtained."],
      request:
        "PUT child resources with a tagged If header referring to the collection token",
      assertions: [
        "A current sync token permits the PUT.",
        "The same token fails with 412 after the collection changes.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("sync-if");
      const initial = await syncReport(client, collection, "");
      await assertStatus(initial, 207);
      const token = parseDavMultiStatus(await initial.text()).syncToken;
      assert.ok(token, "Initial synchronization is missing DAV:sync-token");
      const ifHeader = `<${client.url(collection)}> (<${token}>)`;

      const permitted = await client.request(`${collection}permitted.txt`, {
        method: "PUT",
        headers: { If: ifHeader },
        body: "permitted",
      });
      await assertStatus(permitted, 201);
      const intervening = await client.request(`${collection}intervening.txt`, {
        method: "PUT",
        body: "intervening",
      });
      await assertStatus(intervening, 201);
      const rejected = await client.request(`${collection}rejected.txt`, {
        method: "PUT",
        headers: { If: ifHeader },
        body: "rejected",
      });
      await assertStatus(rejected, 412);
    },
  );
}

async function syncReport(
  client: WebDavTestClient,
  path: string,
  token: string,
  level = "1",
  depth = "0",
) {
  const tokenElement = token
    ? `<D:sync-token>${escapeXml(token)}</D:sync-token>`
    : "<D:sync-token/>";
  return client.request(path, {
    method: "REPORT",
    headers: { "Content-Type": "application/xml", Depth: depth },
    body: `<D:sync-collection xmlns:D="DAV:">${tokenElement}<D:sync-level>${level}</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`,
  });
}

function assertUniqueHrefs(hrefs: readonly string[], client: WebDavTestClient) {
  const normalized = hrefs.map((href) => {
    const pathname = new URL(href, client.origin).pathname;
    return pathname.replace(/\/+$/, "") || "/";
  });
  assert.equal(
    new Set(normalized).size,
    normalized.length,
    "Duplicate DAV:href values",
  );
}

function assertUri(value: string) {
  assert.doesNotThrow(() => new URL(value), `Expected URI: ${value}`);
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

import assert from "node:assert/strict";
import {
  DAV_NAMESPACE,
  assertStatus,
  assertUniqueHrefs,
  childElement,
  davChildren,
  findResponseForPath,
  parseDavMultiStatus,
  parseXml,
  propfind,
  propfindBody,
  propertyStatus,
  proppatch,
  proppatchBody,
  requiredProperty,
  responseElementForPath,
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
      assert.doesNotThrow(() => new URL(token), "DAV:sync-token is not a URI");
    },
  );

  rfcTest(
    {
      id: "RFC6578-03.2-002",
      rfc: "6578",
      section: "3.2, 3.3",
      requirement: "MUST",
      title: "sync-collection accepts only Depth 0",
      prerequisites: ["A collection exists."],
      request:
        "REPORT {collection}; DAV:sync-collection with Depth 0, no Depth, Depth 1, and Depth infinity",
      assertions: [
        "Depth 0 and an omitted Depth header produce a 207 DAV:multistatus with exactly one URI sync token.",
        "Depth 1 and Depth infinity each produce 400.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("sync-depth");
      const depthZero = await client.request(collection, {
        method: "REPORT",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: '<D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>',
      });
      const omittedDepth = await client.request(collection, {
        method: "REPORT",
        headers: { "Content-Type": "application/xml" },
        body: '<D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>',
      });
      for (const response of [depthZero, omittedDepth]) {
        await assertStatus(response, 207);
        const xml = await response.text();
        const root = parseXml(xml);
        const tokens = Array.from(root.children).filter(
          (candidate) =>
            candidate.namespaceURI === DAV_NAMESPACE &&
            candidate.localName === "sync-token",
        );
        assert.equal(tokens.length, 1, "Expected exactly one DAV:sync-token");
        const children = Array.from(root.children);
        assert.equal(
          children[children.length - 1],
          tokens[0],
          "DAV:sync-token is not the final direct DAV:multistatus element",
        );
        const token = parseDavMultiStatus(xml).syncToken;
        assert.ok(token, "Synchronization is missing DAV:sync-token");
        assert.doesNotThrow(
          () => new URL(token),
          "DAV:sync-token is not a URI",
        );
      }
      for (const depth of ["1", "infinity"]) {
        const response = await client.request(collection, {
          method: "REPORT",
          headers: { "Content-Type": "application/xml", Depth: depth },
          body: '<D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>',
        });
        await assertStatus(response, 400);
      }
    },
  );

  rfcTest(
    {
      id: "RFC6578-03.2-004",
      rfc: "6578",
      section: "3.2, 3.3, 3.4, 3.6",
      requirement: "MUST",
      title: "Initial synchronization reports each immediate member",
      prerequisites: [
        "A collection has immediate file and collection members, plus a nested file.",
      ],
      request:
        "REPORT {collection}; Depth: 0; empty DAV:sync-token; DAV:sync-level 1",
      assertions: [
        "The response is a 207 DAV:multistatus with exactly one URI sync token.",
        "Without truncation, every immediate member has one response with DAV:propstat and no DAV:status.",
        "Without truncation, the nested file is outside DAV:sync-level 1 and is not reported.",
        "A member removed before initial synchronization is not reported.",
      ],
      alternatives: [
        "RFC 6578 permits truncation; this test does not require that optional behavior.",
      ],
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
      const historicalRemoval = await client.createFile(
        collection,
        "removed-before-sync.txt",
        "removed",
      );
      // Remove a member before the initial synchronization window opens.
      const deleted = await client.request(historicalRemoval, {
        method: "DELETE",
      });
      assert.ok(deleted.ok, `DELETE returned ${deleted.status}`);
      const afterDelete = await client.request(historicalRemoval, {
        method: "GET",
      });
      await assertStatus(afterDelete, 404);

      // Request the initial level-1 synchronization.
      const response = await client.request(collection, {
        method: "REPORT",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: '<D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>',
      });
      await assertStatus(response, 207);
      const xml = await response.text();
      const root = parseXml(xml);
      const tokens = Array.from(root.children).filter(
        (candidate) =>
          candidate.namespaceURI === DAV_NAMESPACE &&
          candidate.localName === "sync-token",
      );
      assert.equal(tokens.length, 1, "Expected exactly one DAV:sync-token");
      const children = Array.from(root.children);
      assert.equal(
        children[children.length - 1],
        tokens[0],
        "DAV:sync-token is not the final direct DAV:multistatus element",
      );
      const multistatus = parseDavMultiStatus(xml);
      const syncToken = multistatus.syncToken;
      assert.ok(syncToken, "Initial synchronization is missing DAV:sync-token");
      assert.doesNotThrow(
        () => new URL(syncToken),
        "DAV:sync-token is not a URI",
      );
      assertUniqueHrefs(
        multistatus.responses.map((item) => item.href),
        client,
      );
      assert.throws(
        () => responseForPath(multistatus, client, historicalRemoval),
        "Initial synchronization reported a removed member",
      );
      const requestResponse = findResponseForPath(
        multistatus,
        client,
        collection,
      );
      if (requestResponse?.status === 507) {
        return;
      }
      assert.equal(
        requestResponse,
        undefined,
        "Initial synchronization reported the request collection as a member",
      );
      for (const path of [first, second, child]) {
        const responseElement = responseElementForPath(xml, client, path);
        assert.equal(
          davChildren(responseElement, "status").length,
          0,
          `Changed member ${path} has DAV:status`,
        );
        assert.ok(
          davChildren(responseElement, "propstat").length > 0,
          `Changed member ${path} has no DAV:propstat`,
        );
      }
      assert.throws(() => responseForPath(multistatus, client, nested));
    },
  );

  rfcTest(
    {
      id: "RFC6578-03.3-001",
      rfc: "6578",
      section: "3.2, 3.3, 3.4, 3.6",
      requirement: "MUST",
      title: "Initial infinite synchronization reports supported descendants",
      prerequisites: [
        "A collection has a child collection that supports DAV:sync-collection and a nested file.",
      ],
      request:
        "REPORT {collection}; Depth: 0; empty DAV:sync-token; DAV:sync-level infinite",
      assertions: [
        "Without truncation, the child collection and nested file have changed-member responses.",
        "If traversal is unavailable, the child has the specified 403 DAV:sync-traversal-supported response.",
      ],
      alternatives: [
        "RFC 6578 permits truncation and permits a 403 DAV:sync-traversal-supported response for an otherwise capable child collection.",
      ],
    },
    async () => {
      const collection = await client.createCollection("sync-infinite");
      const child = await client.createCollectionAt(`${collection}child/`);
      const nested = await client.createFile(child, "nested.txt", "nested");

      const discovery = await propfind(
        client,
        child,
        propfindBody("<D:supported-report-set/>"),
      );
      await assertStatus(discovery, 207);
      const childDiscovery = responseForPath(
        parseDavMultiStatus(await discovery.text()),
        client,
        child,
      );
      assert.equal(
        propertyStatus(
          childDiscovery.propstats,
          DAV_NAMESPACE,
          "supported-report-set",
        ),
        200,
      );
      const reportSet = requiredProperty(
        childDiscovery.propstats,
        DAV_NAMESPACE,
        "supported-report-set",
      );
      assert.ok(
        reportSet.getElementsByTagNameNS(DAV_NAMESPACE, "sync-collection")
          .length > 0,
        "Child collection does not list DAV:sync-collection",
      );

      // Request the initial infinite synchronization after confirming traversal support.
      const response = await client.request(collection, {
        method: "REPORT",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: '<D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:sync-level>infinite</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>',
      });
      await assertStatus(response, 207);
      const responseXml = await response.text();
      const root = parseXml(responseXml);
      const tokens = Array.from(root.children).filter(
        (candidate) =>
          candidate.namespaceURI === DAV_NAMESPACE &&
          candidate.localName === "sync-token",
      );
      assert.equal(tokens.length, 1, "Expected exactly one DAV:sync-token");
      const children = Array.from(root.children);
      assert.equal(
        children[children.length - 1],
        tokens[0],
        "DAV:sync-token is not the final direct DAV:multistatus element",
      );
      const multistatus = parseDavMultiStatus(responseXml);
      const syncToken = multistatus.syncToken;
      assert.ok(syncToken, "Initial synchronization is missing DAV:sync-token");
      assert.doesNotThrow(
        () => new URL(syncToken),
        "DAV:sync-token is not a URI",
      );
      assertUniqueHrefs(
        multistatus.responses.map((item) => item.href),
        client,
      );

      const requestResponse = findResponseForPath(
        multistatus,
        client,
        collection,
      );
      if (requestResponse?.status === 507) {
        return;
      }

      const childItem = responseForPath(multistatus, client, child);
      if (childItem.status === 403) {
        const responseElement = responseElementForPath(
          responseXml,
          client,
          child,
        );
        assert.equal(
          davChildren(responseElement, "status").length,
          1,
          `Traversal failure for ${child} does not have exactly one DAV:status`,
        );
        assert.equal(
          davChildren(responseElement, "propstat").length,
          0,
          `Traversal failure for ${child} has DAV:propstat`,
        );
        const error = childElement(responseElement, DAV_NAMESPACE, "error");
        assert.ok(error, `Missing DAV:error for ${child}`);
        assert.ok(
          childElement(error, DAV_NAMESPACE, "sync-traversal-supported"),
          `Missing DAV:sync-traversal-supported for ${child}`,
        );
        return;
      }
      for (const path of [child, nested]) {
        const responseElement = responseElementForPath(
          responseXml,
          client,
          path,
        );
        assert.equal(
          davChildren(responseElement, "status").length,
          0,
          `Changed member ${path} has DAV:status`,
        );
        assert.ok(
          davChildren(responseElement, "propstat").length > 0,
          `Changed member ${path} has no DAV:propstat`,
        );
      }
    },
  );

  rfcTest(
    {
      id: "RFC6578-03.5-001",
      rfc: "6578",
      section: "3.2, 3.5.1, 3.5.2, 3.6, 4",
      requirement: "MUST",
      title: "Subsequent synchronization reports member mapping transitions",
      prerequisites: [
        "A collection synchronization token is obtained before existing member URLs are removed or remapped and new member URLs are created.",
      ],
      request:
        "REPORT {collection}; DAV:sync-token from before member removals, mappings, and remapping",
      assertions: [
        "Without truncation, a newly mapped member has DAV:propstat and no DAV:status.",
        "Without truncation, an existing member that is removed and a new member that is removed each have DAV:status 404 and no DAV:propstat.",
        "Without truncation, a member URL removed then remapped is reported as changed and not removed.",
        "No member URL appears more than once.",
        "The response contains exactly one URI sync token.",
      ],
      alternatives: [
        "RFC 6578 permits truncation; this test does not require that optional behavior.",
      ],
    },
    async () => {
      const collection = await client.createCollection("sync-changes");
      const removed = await client.createFile(
        collection,
        "removed.txt",
        "remove",
      );
      const remapped = await client.createFile(
        collection,
        "remapped.txt",
        "before",
      );
      // Capture the token before changing the collection mapping.
      const tokenResponse = await propfind(
        client,
        collection,
        propfindBody("<D:sync-token/>"),
      );
      await assertStatus(tokenResponse, 207);
      const tokenItem = responseForPath(
        parseDavMultiStatus(await tokenResponse.text()),
        client,
        collection,
      );
      assert.equal(
        propertyStatus(tokenItem.propstats, DAV_NAMESPACE, "sync-token"),
        200,
      );
      const token = requiredProperty(
        tokenItem.propstats,
        DAV_NAMESPACE,
        "sync-token",
      ).textContent;
      assert.ok(token, "DAV:sync-token is empty");
      assert.doesNotThrow(() => new URL(token), "DAV:sync-token is not a URI");

      // Create each mapping transition inside the token window.
      const added = await client.createFile(collection, "added.txt", "added");
      const addedThenRemoved = await client.createFile(
        collection,
        "added-then-removed.txt",
        "temporary",
      );
      for (const path of [removed, addedThenRemoved, remapped]) {
        const deleted = await client.request(path, { method: "DELETE" });
        assert.ok(deleted.ok, `DELETE returned ${deleted.status}`);
        const afterDelete = await client.request(path, { method: "GET" });
        await assertStatus(afterDelete, 404);
      }
      const recreated = await client.request(remapped, {
        method: "PUT",
        body: "after",
      });
      assert.ok(
        recreated.ok,
        `Recreating ${remapped} returned ${recreated.status}`,
      );

      // Synchronize the changes since the baseline token.
      const response = await client.request(collection, {
        method: "REPORT",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: `<D:sync-collection xmlns:D="DAV:"><D:sync-token>${token
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll(
            "'",
            "&apos;",
          )}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`,
      });
      await assertStatus(response, 207);
      const xml = await response.text();
      const root = parseXml(xml);
      const tokens = Array.from(root.children).filter(
        (candidate) =>
          candidate.namespaceURI === DAV_NAMESPACE &&
          candidate.localName === "sync-token",
      );
      assert.equal(tokens.length, 1, "Expected exactly one DAV:sync-token");
      const children = Array.from(root.children);
      assert.equal(
        children[children.length - 1],
        tokens[0],
        "DAV:sync-token is not the final direct DAV:multistatus element",
      );
      const multistatus = parseDavMultiStatus(xml);
      const syncToken = multistatus.syncToken;
      assert.ok(
        syncToken,
        "Subsequent synchronization is missing DAV:sync-token",
      );
      assert.doesNotThrow(
        () => new URL(syncToken),
        "DAV:sync-token is not a URI",
      );
      assertUniqueHrefs(
        multistatus.responses.map((item) => item.href),
        client,
      );
      const requestResponse = findResponseForPath(
        multistatus,
        client,
        collection,
      );
      if (requestResponse?.status === 507) {
        return;
      }
      for (const path of [added, remapped]) {
        const responseElement = responseElementForPath(xml, client, path);
        assert.equal(
          davChildren(responseElement, "status").length,
          0,
          `Changed member ${path} has DAV:status`,
        );
        assert.ok(
          davChildren(responseElement, "propstat").length > 0,
          `Changed member ${path} has no DAV:propstat`,
        );
      }
      for (const path of [removed, addedThenRemoved]) {
        const item = responseForPath(multistatus, client, path);
        assert.equal(item.status, 404);
        const responseElement = responseElementForPath(xml, client, path);
        assert.equal(
          davChildren(responseElement, "status").length,
          1,
          `Removed member ${path} does not have exactly one DAV:status`,
        );
        assert.equal(
          davChildren(responseElement, "propstat").length,
          0,
          `Removed member ${path} has DAV:propstat`,
        );
      }
    },
  );

  rfcTest(
    {
      id: "RFC6578-03.5-004",
      rfc: "6578",
      section: "3.2, 3.5.2, 3.6, 4",
      requirement: "MUST NOT",
      title:
        "Infinite synchronization does not report descendants of a removed collection",
      prerequisites: [
        "A collection synchronization token is obtained while it has a child collection with a nested member.",
      ],
      request:
        "REPORT {collection}; DAV:sync-token from before a child collection is deleted; DAV:sync-level infinite",
      assertions: [
        "Without truncation, the deleted child collection has a 404 DAV:status response and no DAV:propstat.",
        "Without truncation, the deleted child collection's nested member is not reported.",
        "The response contains exactly one URI sync token.",
      ],
      alternatives: [
        "RFC 6578 permits truncation; this test does not require that optional behavior.",
      ],
    },
    async () => {
      const collection = await client.createCollection(
        "sync-remove-collection",
      );
      const child = await client.createCollectionAt(`${collection}child/`);
      const nested = await client.createFile(child, "nested.txt", "nested");
      // Capture the token while the child collection remains mapped.
      const tokenResponse = await propfind(
        client,
        collection,
        propfindBody("<D:sync-token/>"),
      );
      await assertStatus(tokenResponse, 207);
      const tokenItem = responseForPath(
        parseDavMultiStatus(await tokenResponse.text()),
        client,
        collection,
      );
      assert.equal(
        propertyStatus(tokenItem.propstats, DAV_NAMESPACE, "sync-token"),
        200,
      );
      const token = requiredProperty(
        tokenItem.propstats,
        DAV_NAMESPACE,
        "sync-token",
      ).textContent;
      assert.ok(token, "DAV:sync-token is empty");
      assert.doesNotThrow(() => new URL(token), "DAV:sync-token is not a URI");

      const deleted = await client.request(child, { method: "DELETE" });
      assert.ok(deleted.ok, `DELETE returned ${deleted.status}`);
      const afterDelete = await client.request(child, { method: "GET" });
      await assertStatus(afterDelete, 404);

      // Synchronize all descendants from the pre-deletion token.
      const response = await client.request(collection, {
        method: "REPORT",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: `<D:sync-collection xmlns:D="DAV:"><D:sync-token>${token
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll(
            "'",
            "&apos;",
          )}</D:sync-token><D:sync-level>infinite</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`,
      });
      await assertStatus(response, 207);
      const xml = await response.text();
      const root = parseXml(xml);
      const tokens = Array.from(root.children).filter(
        (candidate) =>
          candidate.namespaceURI === DAV_NAMESPACE &&
          candidate.localName === "sync-token",
      );
      assert.equal(tokens.length, 1, "Expected exactly one DAV:sync-token");
      const children = Array.from(root.children);
      assert.equal(
        children[children.length - 1],
        tokens[0],
        "DAV:sync-token is not the final direct DAV:multistatus element",
      );
      const multistatus = parseDavMultiStatus(xml);
      const syncToken = multistatus.syncToken;
      assert.ok(
        syncToken,
        "Subsequent synchronization is missing DAV:sync-token",
      );
      assert.doesNotThrow(
        () => new URL(syncToken),
        "DAV:sync-token is not a URI",
      );
      assertUniqueHrefs(
        multistatus.responses.map((item) => item.href),
        client,
      );

      const requestResponse = findResponseForPath(
        multistatus,
        client,
        collection,
      );
      if (requestResponse?.status === 507) return;

      const childItem = responseForPath(multistatus, client, child);
      assert.equal(childItem.status, 404);
      const responseElement = responseElementForPath(xml, client, child);
      assert.equal(
        davChildren(responseElement, "status").length,
        1,
        `Removed member ${child} does not have exactly one DAV:status`,
      );
      assert.equal(
        davChildren(responseElement, "propstat").length,
        0,
        `Removed member ${child} has DAV:propstat`,
      );
      assert.throws(() => responseForPath(multistatus, client, nested));
    },
  );

  rfcTest(
    {
      id: "RFC6578-04-001",
      rfc: "6578",
      section: "3.2, 4",
      requirement: "MUST",
      title: "DAV:sync-token is protected and reflects the collection state",
      prerequisites: ["A collection supports DAV:sync-collection."],
      request:
        "PROPPATCH {collection}; DAV:set(DAV:sync-token), then PROPFIND and REPORT {collection}",
      assertions: [
        "DAV:sync-token is not reported with status 200 and does not adopt the client-provided value.",
        "Without intervening changes, the DAV:sync-token property equals the token returned by REPORT.",
      ],
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

      // Read the server-controlled token after the rejected update.
      const tokenResponse = await propfind(
        client,
        collection,
        propfindBody("<D:sync-token/>"),
      );
      await assertStatus(tokenResponse, 207);
      const tokenItem = responseForPath(
        parseDavMultiStatus(await tokenResponse.text()),
        client,
        collection,
      );
      assert.equal(
        propertyStatus(tokenItem.propstats, DAV_NAMESPACE, "sync-token"),
        200,
      );
      const currentToken = requiredProperty(
        tokenItem.propstats,
        DAV_NAMESPACE,
        "sync-token",
      ).textContent;
      assert.ok(currentToken, "DAV:sync-token is empty");
      assert.doesNotThrow(
        () => new URL(currentToken),
        "DAV:sync-token is not a URI",
      );
      assert.notEqual(
        currentToken,
        "urn:example:changed",
        "DAV:sync-token accepted the client-provided value",
      );

      // The initial REPORT token must match the property value without changes.
      const report = await client.request(collection, {
        method: "REPORT",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: '<D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>',
      });
      await assertStatus(report, 207);
      const xml = await report.text();
      const root = parseXml(xml);
      const tokens = Array.from(root.children).filter(
        (candidate) =>
          candidate.namespaceURI === DAV_NAMESPACE &&
          candidate.localName === "sync-token",
      );
      assert.equal(tokens.length, 1, "Expected exactly one DAV:sync-token");
      const children = Array.from(root.children);
      assert.equal(
        children[children.length - 1],
        tokens[0],
        "DAV:sync-token is not the final direct DAV:multistatus element",
      );
      const reportToken = parseDavMultiStatus(xml).syncToken;
      assert.ok(reportToken, "REPORT response is missing DAV:sync-token");
      assert.equal(reportToken, currentToken);
    },
  );

  rfcTest(
    {
      id: "RFC6578-05-001",
      rfc: "6578",
      section: "4, 5",
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
      // Obtain the collection token before constructing the If condition.
      const tokenResponse = await propfind(
        client,
        collection,
        propfindBody("<D:sync-token/>"),
      );
      await assertStatus(tokenResponse, 207);
      const tokenItem = responseForPath(
        parseDavMultiStatus(await tokenResponse.text()),
        client,
        collection,
      );
      assert.equal(
        propertyStatus(tokenItem.propstats, DAV_NAMESPACE, "sync-token"),
        200,
      );
      const token = requiredProperty(
        tokenItem.propstats,
        DAV_NAMESPACE,
        "sync-token",
      ).textContent;
      assert.ok(token, "DAV:sync-token is empty");
      assert.doesNotThrow(() => new URL(token), "DAV:sync-token is not a URI");
      const ifHeader = `<${client.url(collection)}> (<${token}>)`;

      const permitted = await client.request(`${collection}permitted.txt`, {
        method: "PUT",
        headers: { If: ifHeader },
        body: "permitted",
      });
      assert.ok(
        permitted.ok,
        `PUT with current DAV:sync-token returned ${permitted.status}`,
      );
      const intervening = await client.request(`${collection}intervening.txt`, {
        method: "PUT",
        body: "intervening",
      });
      assert.ok(
        intervening.ok,
        `Intervening PUT returned ${intervening.status}`,
      );
      const rejected = await client.request(`${collection}rejected.txt`, {
        method: "PUT",
        headers: { If: ifHeader },
        body: "rejected",
      });
      await assertStatus(rejected, 412);
    },
  );
}

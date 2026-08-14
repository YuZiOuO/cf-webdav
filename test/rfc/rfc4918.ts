import assert from "node:assert/strict";
import {
  DAV_NAMESPACE,
  TEST_NAMESPACE,
  assertElement,
  assertStatus,
  childElement,
  parseDavMultiStatus,
  parseXml,
  propfind,
  propfindBody,
  propertyStatus,
  proppatch,
  proppatchBody,
  requiredChild,
  requiredProperty,
  responseForPath,
  rfcTest,
  type WebDavTestClient,
} from "./support";

export function registerRfc4918Tests(client: WebDavTestClient) {
  rfcTest(
    {
      id: "RFC4918-10.1-001",
      rfc: "4918",
      section: "10.1",
      requirement: "MUST",
      title: "OPTIONS advertises DAV class 1",
      prerequisites: ["The request target is a WebDAV resource."],
      request: "OPTIONS /",
      assertions: [
        "The response is successful.",
        "The DAV response header contains compliance class 1.",
      ],
      alternatives: ["Additional DAV compliance classes may be advertised."],
    },
    async () => {
      const response = await client.request("/", { method: "OPTIONS" });
      assert.ok(response.ok, `OPTIONS returned ${response.status}`);
      const dav = response.headers.get("DAV");
      assert.ok(dav, "OPTIONS response is missing the DAV header");
      assert.ok(
        dav
          .split(",")
          .map((value) => value.trim())
          .includes("1"),
        `DAV header does not advertise class 1: ${dav}`,
      );
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.1-001",
      rfc: "4918",
      section: "9.1",
      requirement: "MUST",
      title: "PROPFIND reports named property status in DAV:propstat",
      prerequisites: ["A non-collection resource exists."],
      request: "PROPFIND {resource}; Depth: 0; DAV:prop(getetag, missing)",
      assertions: [
        "The response is 207 with a DAV:multistatus XML root.",
        "DAV:getetag has status 200.",
        "The absent property has status 404.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("propfind-named");
      const file = await client.createFile(collection, "document.txt", "body");
      const response = await propfind(
        client,
        file,
        propfindBody("<D:getetag/><T:missing/>"),
      );
      await assertStatus(response, 207);
      const multistatus = parseDavMultiStatus(await response.text());
      const item = responseForPath(multistatus, client, file);
      assert.equal(
        propertyStatus(item.propstats, DAV_NAMESPACE, "getetag"),
        200,
      );
      assert.equal(
        propertyStatus(item.propstats, TEST_NAMESPACE, "missing"),
        404,
      );
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.1-002",
      rfc: "4918",
      section: "9.1",
      requirement: "MUST",
      title: "PROPFIND supports Depth 0 and Depth 1",
      prerequisites: [
        "A collection has an immediate file, an immediate child collection, and a nested file.",
      ],
      request: "PROPFIND {collection}; Depth: 0 and Depth: 1",
      assertions: [
        "Depth 0 returns only the request target.",
        "Depth 1 returns the request target and its immediate members.",
        "Depth 1 excludes descendants below immediate child collections.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("propfind-depth");
      const immediateFile = await client.createFile(
        collection,
        "direct.txt",
        "direct",
      );
      const childCollection = await client.createCollectionAt(
        `${collection}child/`,
      );
      const nestedFile = await client.createFile(
        childCollection,
        "nested.txt",
        "nested",
      );

      const depthZero = await propfind(
        client,
        collection,
        propfindBody("<D:resourcetype/>"),
        "0",
      );
      await assertStatus(depthZero, 207);
      const zeroResponse = parseDavMultiStatus(await depthZero.text());
      assert.equal(zeroResponse.responses.length, 1);
      responseForPath(zeroResponse, client, collection);

      const depthOne = await propfind(
        client,
        collection,
        propfindBody("<D:resourcetype/>"),
        "1",
      );
      await assertStatus(depthOne, 207);
      const oneResponse = parseDavMultiStatus(await depthOne.text());
      assert.equal(oneResponse.responses.length, 3);
      responseForPath(oneResponse, client, collection);
      responseForPath(oneResponse, client, immediateFile);
      responseForPath(oneResponse, client, childCollection);
      assert.throws(() => responseForPath(oneResponse, client, nestedFile));
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.2-001",
      rfc: "4918",
      section: "9.2",
      requirement: "SHOULD",
      title: "PROPPATCH stores an arbitrary dead property",
      prerequisites: ["A non-collection resource exists."],
      request: "PROPPATCH {resource}; DAV:set(T:color)",
      assertions: [
        "The response is 207 and reports status 200 for T:color.",
        "A subsequent PROPFIND returns the XML property value.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("proppatch-set");
      const file = await client.createFile(collection, "document.txt", "body");
      const response = await proppatch(
        client,
        file,
        proppatchBody(
          "<D:set><D:prop><T:color>blue</T:color></D:prop></D:set>",
        ),
      );
      await assertStatus(response, 207);
      const patched = parseDavMultiStatus(await response.text());
      const patchedItem = responseForPath(patched, client, file);
      assert.equal(
        propertyStatus(patchedItem.propstats, TEST_NAMESPACE, "color"),
        200,
      );

      const found = await propfind(client, file, propfindBody("<T:color/>"));
      await assertStatus(found, 207);
      const foundItem = responseForPath(
        parseDavMultiStatus(await found.text()),
        client,
        file,
      );
      assert.equal(
        propertyStatus(foundItem.propstats, TEST_NAMESPACE, "color"),
        200,
      );
      assert.equal(
        requiredProperty(foundItem.propstats, TEST_NAMESPACE, "color")
          .textContent,
        "blue",
      );
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.2-002",
      rfc: "4918",
      section: "9.2",
      requirement: "MUST",
      title: "PROPPATCH failures are atomic",
      prerequisites: ["A non-collection resource exists."],
      request: "PROPPATCH {resource}; DAV:set(T:atomic, DAV:getetag)",
      assertions: [
        "The protected DAV:getetag change has status 403.",
        "The otherwise valid T:atomic change has status 424.",
        "T:atomic is absent after the failed request.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("proppatch-atomic");
      const file = await client.createFile(collection, "document.txt", "body");
      const response = await proppatch(
        client,
        file,
        proppatchBody(
          "<D:set><D:prop><T:atomic>value</T:atomic><D:getetag>invalid</D:getetag></D:prop></D:set>",
        ),
      );
      await assertStatus(response, 207);
      const result = responseForPath(
        parseDavMultiStatus(await response.text()),
        client,
        file,
      );
      assert.equal(
        propertyStatus(result.propstats, DAV_NAMESPACE, "getetag"),
        403,
      );
      assert.equal(
        propertyStatus(result.propstats, TEST_NAMESPACE, "atomic"),
        424,
      );

      const found = await propfind(client, file, propfindBody("<T:atomic/>"));
      await assertStatus(found, 207);
      const foundItem = responseForPath(
        parseDavMultiStatus(await found.text()),
        client,
        file,
      );
      assert.equal(
        propertyStatus(foundItem.propstats, TEST_NAMESPACE, "atomic"),
        404,
      );
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.3-001",
      rfc: "4918",
      section: "9.3",
      requirement: "MUST",
      title: "MKCOL creates a collection resource",
      prerequisites: [
        "The target is unmapped and its parent collection exists.",
      ],
      request: "MKCOL {collection}",
      assertions: [
        "The response is 201.",
        "DAV:resourcetype contains DAV:collection on the created resource.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("mkcol");
      const response = await propfind(
        client,
        collection,
        propfindBody("<D:resourcetype/>"),
      );
      await assertStatus(response, 207);
      const item = responseForPath(
        parseDavMultiStatus(await response.text()),
        client,
        collection,
      );
      assert.equal(
        propertyStatus(item.propstats, DAV_NAMESPACE, "resourcetype"),
        200,
      );
      assert.ok(
        childElement(
          requiredProperty(item.propstats, DAV_NAMESPACE, "resourcetype"),
          DAV_NAMESPACE,
          "collection",
        ),
      );
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.6-001",
      rfc: "4918",
      section: "9.6.1",
      requirement: "MUST",
      title: "DELETE removes a collection and its members",
      prerequisites: ["A collection contains a non-collection member."],
      request: "DELETE {collection}",
      assertions: [
        "The response is 204.",
        "The collection member is no longer mapped.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("delete");
      const file = await client.createFile(collection, "document.txt", "body");
      const deleted = await client.request(collection, { method: "DELETE" });
      await assertStatus(deleted, 204);
      const result = await client.request(file, { method: "GET" });
      await assertStatus(result, 404);
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.7-001",
      rfc: "4918",
      section: "9.7.1",
      requirement: "MUST",
      title: "PUT creates and replaces a non-collection resource",
      prerequisites: ["The parent collection exists."],
      request: "PUT {resource} twice with distinct bodies",
      assertions: [
        "The first response is 201.",
        "The replacement response is 204.",
        "GET returns the replacement representation.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("put");
      const file = `${collection}document.txt`;
      const created = await client.request(file, {
        method: "PUT",
        body: "first",
      });
      await assertStatus(created, 201);
      const replaced = await client.request(file, {
        method: "PUT",
        body: "second",
      });
      await assertStatus(replaced, 204);
      const fetched = await client.request(file, { method: "GET" });
      await assertStatus(fetched, 200);
      assert.equal(await fetched.text(), "second");
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.8-001",
      rfc: "4918",
      section: "9.8.4",
      requirement: "MUST",
      title: "COPY honors Overwrite F and the default Overwrite T",
      prerequisites: ["Distinct source and destination resources exist."],
      request:
        "COPY {source}; Destination: {destination}; Overwrite: F, then absent",
      assertions: [
        "Overwrite F returns 412 and preserves the destination representation.",
        "An absent Overwrite header replaces the destination and returns 204.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("copy-overwrite");
      const source = await client.createFile(
        collection,
        "source.txt",
        "source",
      );
      const destination = await client.createFile(
        collection,
        "destination.txt",
        "destination",
      );

      const blocked = await client.request(source, {
        method: "COPY",
        headers: {
          Destination: client.url(destination),
          Overwrite: "F",
        },
      });
      await assertStatus(blocked, 412);
      const unchanged = await client.request(destination, { method: "GET" });
      await assertStatus(unchanged, 200);
      assert.equal(await unchanged.text(), "destination");

      const overwritten = await client.request(source, {
        method: "COPY",
        headers: { Destination: client.url(destination) },
      });
      await assertStatus(overwritten, 204);
      const copied = await client.request(destination, { method: "GET" });
      await assertStatus(copied, 200);
      assert.equal(await copied.text(), "source");
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.8-002",
      rfc: "4918",
      section: "9.8.3",
      requirement: "MUST",
      title: "COPY applies collection depth",
      prerequisites: ["A collection contains a non-collection member."],
      request: "COPY {collection}; Depth: 0, then Depth: infinity",
      assertions: [
        "Depth 0 creates the destination collection without its member.",
        "Depth infinity creates the destination collection with its member.",
      ],
      alternatives: [],
    },
    async () => {
      const source = await client.createCollection("copy-depth-source");
      await client.createFile(source, "document.txt", "body");
      const shallowDestination = client.newPath("copy-depth-shallow");
      const shallow = await client.request(source, {
        method: "COPY",
        headers: { Destination: client.url(shallowDestination), Depth: "0" },
      });
      await assertStatus(shallow, 201);
      const shallowMember = await client.request(
        `${shallowDestination}document.txt`,
        {
          method: "GET",
        },
      );
      await assertStatus(shallowMember, 404);

      const deepDestination = client.newPath("copy-depth-deep");
      const deep = await client.request(source, {
        method: "COPY",
        headers: {
          Destination: client.url(deepDestination),
          Depth: "infinity",
        },
      });
      await assertStatus(deep, 201);
      const deepMember = await client.request(
        `${deepDestination}document.txt`,
        {
          method: "GET",
        },
      );
      await assertStatus(deepMember, 200);
      assert.equal(await deepMember.text(), "body");
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.9-001",
      rfc: "4918",
      section: "9.9.4",
      requirement: "MUST",
      title: "MOVE replaces an existing destination and removes the source",
      prerequisites: ["Distinct source and destination resources exist."],
      request: "MOVE {source}; Destination: {destination}; Overwrite omitted",
      assertions: [
        "The response is 204.",
        "The source is no longer mapped.",
        "The destination has the former source representation.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("move");
      const source = await client.createFile(
        collection,
        "source.txt",
        "source",
      );
      const destination = await client.createFile(
        collection,
        "destination.txt",
        "destination",
      );
      const moved = await client.request(source, {
        method: "MOVE",
        headers: { Destination: client.url(destination) },
      });
      await assertStatus(moved, 204);
      const oldLocation = await client.request(source, { method: "GET" });
      await assertStatus(oldLocation, 404);
      const newLocation = await client.request(destination, { method: "GET" });
      await assertStatus(newLocation, 200);
      assert.equal(await newLocation.text(), "source");
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.10-001",
      rfc: "4918",
      section: "9.10.1, 9.10.2, 9.11",
      requirement: "MUST",
      title: "LOCK creation, refresh, conditional write, and UNLOCK",
      prerequisites: ["A non-collection resource exists and is unlocked."],
      request: "LOCK {resource}; PUT with and without If; refresh LOCK; UNLOCK",
      assertions: [
        "A new lock returns a DAV:lockdiscovery body and Lock-Token header.",
        "An unconditioned write is rejected with 423, while the matching lock token permits it.",
        "A refresh returns DAV:lockdiscovery without a Lock-Token response header.",
        "UNLOCK returns 204 and removes the lock.",
      ],
      alternatives: ["The server may choose the lock timeout."],
    },
    async () => {
      const collection = await client.createCollection("lock");
      const file = await client.createFile(
        collection,
        "document.txt",
        "before",
      );
      const created = await client.request(file, {
        method: "LOCK",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
      });
      await assertStatus(created, 200);
      const lockTokenHeader = created.headers.get("Lock-Token");
      assert.ok(lockTokenHeader, "LOCK response is missing Lock-Token");
      const tokenMatch = /^<([^>]+)>$/.exec(lockTokenHeader);
      assert.ok(tokenMatch, `Invalid Lock-Token header: ${lockTokenHeader}`);
      const token = tokenMatch[1];

      const lockRoot = parseXml(await created.text());
      assertElement(lockRoot, DAV_NAMESPACE, "prop");
      const activeLock = requiredChild(
        requiredChild(lockRoot, DAV_NAMESPACE, "lockdiscovery"),
        DAV_NAMESPACE,
        "activelock",
      );
      assert.equal(
        requiredChild(
          requiredChild(activeLock, DAV_NAMESPACE, "locktoken"),
          DAV_NAMESPACE,
          "href",
        ).textContent,
        token,
      );

      const blocked = await client.request(file, {
        method: "PUT",
        body: "blocked",
      });
      await assertStatus(blocked, 423);
      const permitted = await client.request(file, {
        method: "PUT",
        headers: { If: `(<${token}>)` },
        body: "permitted",
      });
      await assertStatus(permitted, 204);

      const refreshed = await client.request(file, {
        method: "LOCK",
        headers: { If: `(<${token}>)` },
      });
      await assertStatus(refreshed, 200);
      assert.equal(refreshed.headers.get("Lock-Token"), null);
      const refreshedRoot = parseXml(await refreshed.text());
      assert.ok(
        childElement(refreshedRoot, DAV_NAMESPACE, "lockdiscovery"),
        "A refresh response is missing DAV:lockdiscovery",
      );

      const unlocked = await client.request(file, {
        method: "UNLOCK",
        headers: { "Lock-Token": `<${token}>` },
      });
      await assertStatus(unlocked, 204);
      const afterUnlock = await client.request(file, {
        method: "PUT",
        body: "after",
      });
      await assertStatus(afterUnlock, 204);
    },
  );

  rfcTest(
    {
      id: "RFC4918-10.4-001",
      rfc: "4918",
      section: "10.4.1, 10.4.3, 10.4.4",
      requirement: "MUST",
      title: "If evaluates entity-tag conditions",
      prerequisites: ["A non-collection resource with an entity tag exists."],
      request:
        "PUT {resource}; If with a non-matching and then matching entity tag",
      assertions: [
        "An all-false If header returns 412 and leaves the representation unchanged.",
        "A matching If header permits the request.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("if-header");
      const file = await client.createFile(
        collection,
        "document.txt",
        "before",
      );
      const current = await client.request(file, { method: "HEAD" });
      await assertStatus(current, 200);
      const etag = current.headers.get("ETag");
      assert.ok(etag, "Resource is missing ETag");

      const rejected = await client.request(file, {
        method: "PUT",
        headers: { If: '(["not-the-current-etag"])' },
        body: "rejected",
      });
      await assertStatus(rejected, 412);
      const unchanged = await client.request(file, { method: "GET" });
      await assertStatus(unchanged, 200);
      assert.equal(await unchanged.text(), "before");

      const accepted = await client.request(file, {
        method: "PUT",
        headers: { If: `([${etag}])` },
        body: "accepted",
      });
      await assertStatus(accepted, 204);
      const changed = await client.request(file, { method: "GET" });
      await assertStatus(changed, 200);
      assert.equal(await changed.text(), "accepted");
    },
  );
}

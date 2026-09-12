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
      id: "RFC4918-08.2-001",
      rfc: "4918",
      section: "8.2",
      requirement: "MUST",
      title: "WebDAV validates and accepts XML request bodies",
      prerequisites: ["A WebDAV resource exists."],
      request:
        "PROPFIND {resource}; malformed application/xml body, then well-formed application/xml and text/xml DAV:prop requests",
      assertions: [
        "Malformed XML is rejected with 400.",
        "Well-formed application/xml and text/xml request bodies are processed successfully.",
        "A successful PROPFIND uses a text/xml or application/xml response body.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("malformed-xml");
      const response = await client.request(collection, {
        method: "PROPFIND",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: '<D:propfind xmlns:D="DAV:"><D:prop>',
      });
      await assertStatus(response, 400);
      for (const contentType of ["application/xml", "text/xml"]) {
        const valid = await client.request(collection, {
          method: "PROPFIND",
          headers: { "Content-Type": contentType, Depth: "0" },
          body: '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
        });
        await assertStatus(valid, 207);
        assert.match(
          valid.headers.get("Content-Type") ?? "",
          /^(?:text|application)\/xml(?:;|$)/i,
          "PROPFIND response is not XML",
        );
        assertElement(
          parseXml(await valid.text()),
          DAV_NAMESPACE,
          "multistatus",
        );
      }
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
      request: "PROPFIND {resource}; Depth: 0; DAV:prop(resourcetype, missing)",
      assertions: [
        "The response is 207 with a DAV:multistatus XML root.",
        "DAV:resourcetype has status 200.",
        "The absent property has status 404.",
        "Every DAV:propstat has exactly one direct DAV:prop and DAV:status child.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("propfind-named");
      const file = await client.createFile(collection, "document.txt", "body");
      const response = await propfind(
        client,
        file,
        propfindBody("<D:resourcetype/><T:missing/>"),
      );
      await assertStatus(response, 207);
      const xml = await response.text();
      const multistatus = parseDavMultiStatus(xml);
      const item = responseForPath(multistatus, client, file);
      assert.equal(
        propertyStatus(item.propstats, DAV_NAMESPACE, "resourcetype"),
        200,
      );
      assert.equal(
        propertyStatus(item.propstats, TEST_NAMESPACE, "missing"),
        404,
      );
      const root = parseXml(xml);
      assertElement(root, DAV_NAMESPACE, "multistatus");
      const propstats = Array.from(root.children)
        .filter(
          (candidate) =>
            candidate.namespaceURI === DAV_NAMESPACE &&
            candidate.localName === "response",
        )
        .flatMap((response) =>
          Array.from(response.children).filter(
            (candidate) =>
              candidate.namespaceURI === DAV_NAMESPACE &&
              candidate.localName === "propstat",
          ),
        );
      assert.ok(propstats.length > 0, "Response has no DAV:propstat");
      for (const propstat of propstats) {
        assert.equal(
          Array.from(propstat.children).filter(
            (candidate) =>
              candidate.namespaceURI === DAV_NAMESPACE &&
              candidate.localName === "prop",
          ).length,
          1,
        );
        assert.equal(
          Array.from(propstat.children).filter(
            (candidate) =>
              candidate.namespaceURI === DAV_NAMESPACE &&
              candidate.localName === "status",
          ).length,
          1,
        );
      }
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
      id: "RFC4918-09.1-004",
      rfc: "4918",
      section: "9.1, 14.2",
      requirement: "MUST",
      title: "PROPFIND allprop and an empty body return dead property values",
      prerequisites: [
        "The authenticated principal can discover an arbitrary dead property on a resource.",
      ],
      request:
        "PROPFIND {resource}; Depth: 0; DAV:allprop, then no request body",
      assertions: [
        "Both requests return the stored dead property with its value.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("propfind-allprop");
      const file = await client.createFile(collection, "document.txt", "body");
      const patched = await proppatch(
        client,
        file,
        proppatchBody(
          "<D:set><D:prop><T:color>blue</T:color></D:prop></D:set>",
        ),
      );
      await assertStatus(patched, 207);

      const allprop = await propfind(
        client,
        file,
        '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
      );
      const empty = await client.request(file, {
        method: "PROPFIND",
        headers: { Depth: "0" },
      });
      for (const response of [allprop, empty]) {
        await assertStatus(response, 207);
        const item = responseForPath(
          parseDavMultiStatus(await response.text()),
          client,
          file,
        );
        assert.equal(
          requiredProperty(item.propstats, TEST_NAMESPACE, "color").textContent,
          "blue",
        );
      }
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.1-005",
      rfc: "4918",
      section: "9.1, 14.21",
      requirement: "MUST",
      title: "PROPFIND propname returns names without values",
      prerequisites: [
        "The authenticated principal can discover an arbitrary dead property on a resource.",
      ],
      request: "PROPFIND {resource}; Depth: 0; DAV:propname",
      assertions: [
        "The stored dead property name is returned without its value.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("propfind-propname");
      const file = await client.createFile(collection, "document.txt", "body");
      const patched = await proppatch(
        client,
        file,
        proppatchBody(
          "<D:set><D:prop><T:color>blue</T:color></D:prop></D:set>",
        ),
      );
      await assertStatus(patched, 207);

      const response = await propfind(
        client,
        file,
        '<D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>',
      );
      await assertStatus(response, 207);
      const item = responseForPath(
        parseDavMultiStatus(await response.text()),
        client,
        file,
      );
      assert.equal(
        requiredProperty(
          item.propstats,
          TEST_NAMESPACE,
          "color",
        ).textContent?.trim(),
        "",
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
      prerequisites: [
        "A non-collection resource exists and the authenticated principal can modify an arbitrary dead property.",
      ],
      request: "PROPPATCH {resource}; DAV:set(T:atomic, DAV:getetag)",
      assertions: [
        "The protected DAV:getetag change is reported as a failure.",
        "The T:atomic change is reported as a failure.",
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
      const getetagStatus = propertyStatus(
        result.propstats,
        DAV_NAMESPACE,
        "getetag",
      );
      assert.ok(
        getetagStatus !== undefined && getetagStatus >= 300,
        "DAV:getetag was not reported as a failure",
      );
      const atomicStatus = propertyStatus(
        result.propstats,
        TEST_NAMESPACE,
        "atomic",
      );
      assert.ok(
        atomicStatus !== undefined && atomicStatus >= 300,
        "T:atomic was not reported as a failure",
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
      id: "RFC4918-09.2-004",
      rfc: "4918",
      section: "9.2",
      requirement: "MUST",
      title:
        "PROPPATCH processes set and remove instructions in document order",
      prerequisites: [
        "The authenticated principal can modify and discover an arbitrary dead property on a resource.",
      ],
      request: "PROPPATCH {resource}; DAV:set(T:color), DAV:remove(T:color)",
      assertions: [
        "The response is 207.",
        "The later remove instruction takes effect and a subsequent PROPFIND reports T:color with status 404.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("proppatch-order");
      const file = await client.createFile(collection, "document.txt", "body");
      const initialized = await proppatch(
        client,
        file,
        proppatchBody(
          "<D:set><D:prop><T:color>initial</T:color></D:prop></D:set>",
        ),
      );
      await assertStatus(initialized, 207);
      const before = await propfind(client, file, propfindBody("<T:color/>"));
      await assertStatus(before, 207);
      const beforeItem = responseForPath(
        parseDavMultiStatus(await before.text()),
        client,
        file,
      );
      assert.equal(
        requiredProperty(beforeItem.propstats, TEST_NAMESPACE, "color")
          .textContent,
        "initial",
      );

      const response = await proppatch(
        client,
        file,
        proppatchBody(
          "<D:set><D:prop><T:color>blue</T:color></D:prop></D:set><D:remove><D:prop><T:color/></D:prop></D:remove>",
        ),
      );
      await assertStatus(response, 207);

      const found = await propfind(client, file, propfindBody("<T:color/>"));
      await assertStatus(found, 207);
      const foundItem = responseForPath(
        parseDavMultiStatus(await found.text()),
        client,
        file,
      );
      assert.equal(
        propertyStatus(foundItem.propstats, TEST_NAMESPACE, "color"),
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
      id: "RFC4918-09.3-002",
      rfc: "4918",
      section: "9.3, 9.3.1",
      requirement: "MUST",
      title: "MKCOL requires an unmapped target with existing ancestors",
      prerequisites: ["The target's direct parent is unmapped."],
      request:
        "MKCOL {missing-parent}/child/, then MKCOL {missing-parent} twice",
      assertions: [
        "MKCOL below a missing parent returns 409.",
        "MKCOL creates the previously missing parent with 201.",
        "A second MKCOL on the mapped target returns 405.",
      ],
      alternatives: [],
    },
    async () => {
      const parent = client.newPath("mkcol-missing-parent");
      const response = await client.request(`${parent}child/`, {
        method: "MKCOL",
      });
      await assertStatus(response, 409);

      const parentCreated = await client.request(parent, { method: "MKCOL" });
      await assertStatus(parentCreated, 201);
      const alreadyMapped = await client.request(parent, { method: "MKCOL" });
      await assertStatus(alreadyMapped, 405);
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.6-001",
      rfc: "4918",
      section: "9.6, 9.6.1",
      requirement: "MUST",
      title: "DELETE removes a collection and its members",
      prerequisites: ["A collection contains a non-collection member."],
      request: "DELETE {collection}",
      assertions: [
        "The DELETE request succeeds.",
        "The request target is no longer mapped.",
        "The collection member is no longer mapped.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("delete");
      const file = await client.createFile(collection, "document.txt", "body");
      const deleted = await client.request(collection, { method: "DELETE" });
      assert.ok(deleted.ok, `DELETE returned ${deleted.status}`);
      for (const path of [collection, file]) {
        const result = await client.request(path, { method: "GET" });
        await assertStatus(result, 404);
      }
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
      id: "RFC4918-09.7-002",
      rfc: "4918",
      section: "9.7.1",
      requirement: "MUST",
      title: "PUT rejects a target without a parent collection",
      prerequisites: ["The target's direct parent collection is unmapped."],
      request: "PUT {missing-parent}/document.txt",
      assertions: ["The response is 409."],
      alternatives: [],
    },
    async () => {
      const parent = client.newPath("put-missing-parent");
      const response = await client.request(`${parent}document.txt`, {
        method: "PUT",
        body: "body",
      });
      await assertStatus(response, 409);
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.8-001",
      rfc: "4918",
      section: "9.8.4, 9.8.5, 10.6",
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
      title: "COPY applies collection Depth 0 and infinity semantics",
      prerequisites: [
        "A collection has a non-collection member and a child collection with a nested member.",
      ],
      request:
        "COPY {collection}; Depth: 0, Depth: infinity, then Depth omitted",
      assertions: [
        "Depth 0 creates the destination collection without descendants.",
        "Depth infinity creates every source descendant at the destination.",
        "An omitted Depth header creates every source descendant at the destination.",
      ],
      alternatives: [],
    },
    async () => {
      const source = await client.createCollection("copy-depth-source");
      const direct = await client.createFile(source, "document.txt", "body");
      const child = await client.createCollectionAt(`${source}child/`);
      const nested = await client.createFile(child, "nested.txt", "nested");
      const shallowDestination = client.newPath("copy-depth-shallow");
      const shallow = await client.request(source, {
        method: "COPY",
        headers: { Destination: client.url(shallowDestination), Depth: "0" },
      });
      await assertStatus(shallow, 201);
      const shallowCollection = await propfind(
        client,
        shallowDestination,
        propfindBody("<D:resourcetype/>"),
      );
      await assertStatus(shallowCollection, 207);
      const shallowItem = responseForPath(
        parseDavMultiStatus(await shallowCollection.text()),
        client,
        shallowDestination,
      );
      assert.ok(
        childElement(
          requiredProperty(
            shallowItem.propstats,
            DAV_NAMESPACE,
            "resourcetype",
          ),
          DAV_NAMESPACE,
          "collection",
        ),
      );
      for (const path of ["document.txt", "child/nested.txt"]) {
        const shallowMember = await client.request(
          `${shallowDestination}${path}`,
          { method: "GET" },
        );
        await assertStatus(shallowMember, 404);
      }

      const deepDestination = client.newPath("copy-depth-deep");
      const deep = await client.request(source, {
        method: "COPY",
        headers: {
          Destination: client.url(deepDestination),
          Depth: "infinity",
        },
      });
      await assertStatus(deep, 201);
      for (const [path, body] of [
        [direct.slice(source.length), "body"],
        [nested.slice(source.length), "nested"],
      ]) {
        const deepMember = await client.request(`${deepDestination}${path}`, {
          method: "GET",
        });
        await assertStatus(deepMember, 200);
        assert.equal(await deepMember.text(), body);
      }
      const defaultDestination = client.newPath("copy-depth-default");
      const defaultDepth = await client.request(source, {
        method: "COPY",
        headers: { Destination: client.url(defaultDestination) },
      });
      await assertStatus(defaultDepth, 201);
      for (const [path, body] of [
        [direct.slice(source.length), "body"],
        [nested.slice(source.length), "nested"],
      ]) {
        const member = await client.request(`${defaultDestination}${path}`, {
          method: "GET",
        });
        await assertStatus(member, 200);
        assert.equal(await member.text(), body);
      }
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.8-004",
      rfc: "4918",
      section: "9.8.5, 9.9.4",
      requirement: "MUST NOT",
      title: "COPY and MOVE do not create missing destination collections",
      prerequisites: [
        "A non-collection source resource exists and the destination parent is unmapped.",
      ],
      request:
        "COPY and MOVE {source}; Destination below an unmapped parent collection",
      assertions: [
        "After both requests, the previously missing destination parent remains available for MKCOL creation.",
      ],
      alternatives: [
        "RFC 4918 forbids automatic intermediate collection creation without mandating the overall response status.",
      ],
    },
    async () => {
      const collection = await client.createCollection(
        "copy-move-missing-parent",
      );
      const source = await client.createFile(
        collection,
        "source.txt",
        "source",
      );
      const parent = client.newPath("copy-missing-parent-destination");
      await client.request(source, {
        method: "COPY",
        headers: { Destination: client.url(`${parent}copy.txt`) },
      });
      await client.request(source, {
        method: "MOVE",
        headers: { Destination: client.url(`${parent}move.txt`) },
      });

      const parentCreated = await client.request(parent, { method: "MKCOL" });
      await assertStatus(parentCreated, 201);
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.8-005",
      rfc: "4918",
      section: "9.8.4",
      requirement: "MUST",
      title: "COPY replaces rather than merges a destination collection",
      prerequisites: [
        "Source and destination collections exist, copying between them is permitted, and each has a distinct immediate member.",
      ],
      request:
        "COPY {source-collection}; Destination: {destination-collection}; Overwrite: T",
      assertions: [
        "After a successful COPY, the destination collection membership matches the source membership before the COPY.",
        "A destination-only member is not retained.",
      ],
      alternatives: [],
    },
    async () => {
      const source = await client.createCollection("copy-overwrite-source");
      const sourceMember = await client.createFile(
        source,
        "source.txt",
        "source",
      );
      const destination = await client.createCollection(
        "copy-overwrite-collection-destination",
      );
      const staleMember = await client.createFile(
        destination,
        "stale.txt",
        "stale",
      );

      const copied = await client.request(source, {
        method: "COPY",
        headers: {
          Destination: client.url(destination),
          Overwrite: "T",
          Depth: "infinity",
        },
      });
      assert.ok(copied.ok, `COPY returned ${copied.status}`);

      const listing = await propfind(
        client,
        destination,
        propfindBody("<D:resourcetype/>"),
        "1",
      );
      await assertStatus(listing, 207);
      const multistatus = parseDavMultiStatus(await listing.text());
      responseForPath(
        multistatus,
        client,
        `${destination}${sourceMember.slice(source.length)}`,
      );
      assert.throws(() =>
        responseForPath(
          multistatus,
          client,
          `${destination}${staleMember.slice(destination.length)}`,
        ),
      );
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.9-002",
      rfc: "4918",
      section: "9.9.1",
      requirement: "MUST",
      title: "MOVE preserves dead properties",
      prerequisites: [
        "The authenticated principal can modify and discover an arbitrary dead property on a resource.",
      ],
      request: "MOVE {source}; PROPFIND {destination}",
      assertions: ["The moved resource retains the source dead property."],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("move-properties");
      const source = await client.createFile(
        collection,
        "source.txt",
        "source",
      );
      const setProperty = await proppatch(
        client,
        source,
        proppatchBody(
          "<D:set><D:prop><T:color>blue</T:color></D:prop></D:set>",
        ),
      );
      await assertStatus(setProperty, 207);

      const destination = `${collection}destination.txt`;
      const movedResponse = await client.request(source, {
        method: "MOVE",
        headers: { Destination: client.url(destination) },
      });
      await assertStatus(movedResponse, 201);

      const found = await propfind(
        client,
        destination,
        propfindBody("<T:color/>"),
      );
      await assertStatus(found, 207);
      const item = responseForPath(
        parseDavMultiStatus(await found.text()),
        client,
        destination,
      );
      assert.equal(
        requiredProperty(item.propstats, TEST_NAMESPACE, "color").textContent,
        "blue",
      );
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.9-001",
      rfc: "4918",
      section: "9.9.3, 9.9.4, 10.6",
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
      id: "RFC4918-09.9-003",
      rfc: "4918",
      section: "9.9.2",
      requirement: "MUST",
      title: "MOVE defaults collection depth to infinity recursively",
      prerequisites: [
        "A collection has a non-collection member and a child collection with a nested member.",
      ],
      request: "MOVE {collection}; Destination: {destination}; Depth omitted",
      assertions: [
        "The response is 201.",
        "The destination contains every source descendant.",
      ],
      alternatives: [],
    },
    async () => {
      const source = await client.createCollection("move-default-depth-source");
      const direct = await client.createFile(source, "document.txt", "body");
      const child = await client.createCollectionAt(`${source}child/`);
      const nested = await client.createFile(child, "nested.txt", "nested");
      const destination = client.newPath("move-default-depth-destination");
      const moved = await client.request(source, {
        method: "MOVE",
        headers: { Destination: client.url(destination) },
      });
      await assertStatus(moved, 201);

      for (const [path, body] of [
        [direct.slice(source.length), "body"],
        [nested.slice(source.length), "nested"],
      ]) {
        const member = await client.request(`${destination}${path}`, {
          method: "GET",
        });
        await assertStatus(member, 200);
        assert.equal(await member.text(), body);
      }
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.9-006",
      rfc: "4918",
      section: "9.6, 9.9, 9.9.2, 9.9.3",
      requirement: "MUST",
      title: "MOVE replaces rather than merges a destination collection",
      prerequisites: [
        "Source and destination collections exist, moving between them is permitted, and the destination has direct and nested members absent from the source.",
      ],
      request:
        "MOVE {source-collection}; Destination: {destination-collection}; Overwrite: T",
      assertions: [
        "After a successful MOVE, the source collection is no longer mapped.",
        "The destination membership matches the source membership before the MOVE.",
        "All destination-only members, including nested members, are removed.",
      ],
      alternatives: [],
    },
    async () => {
      const source = await client.createCollection("move-overwrite-source");
      const sourceMember = await client.createFile(
        source,
        "source.txt",
        "source",
      );
      const destination = await client.createCollection(
        "move-overwrite-collection-destination",
      );
      const staleMember = await client.createFile(
        destination,
        "stale.txt",
        "stale",
      );
      const staleCollection = await client.createCollectionAt(
        `${destination}stale/`,
      );
      const nestedStaleMember = await client.createFile(
        staleCollection,
        "nested.txt",
        "stale",
      );

      const moved = await client.request(source, {
        method: "MOVE",
        headers: {
          Destination: client.url(destination),
          Overwrite: "T",
        },
      });
      assert.ok(moved.ok, `MOVE returned ${moved.status}`);

      const sourceAfterMove = await client.request(source, { method: "GET" });
      await assertStatus(sourceAfterMove, 404);

      const listing = await propfind(
        client,
        destination,
        propfindBody("<D:resourcetype/>"),
        "1",
      );
      await assertStatus(listing, 207);
      const multistatus = parseDavMultiStatus(await listing.text());
      responseForPath(
        multistatus,
        client,
        `${destination}${sourceMember.slice(source.length)}`,
      );
      for (const stalePath of [staleMember, staleCollection]) {
        assert.throws(() =>
          responseForPath(
            multistatus,
            client,
            `${destination}${stalePath.slice(destination.length)}`,
          ),
        );
      }
      const nestedAfterMove = await client.request(nestedStaleMember, {
        method: "GET",
      });
      await assertStatus(nestedAfterMove, 404);
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.10-001",
      rfc: "4918",
      section: "9.10.1, 9.10.2, 9.10.5, 9.11",
      requirement: "MUST",
      title: "LOCK creation, refresh, conditional write, and UNLOCK",
      prerequisites: ["A non-collection resource exists and is unlocked."],
      request: "LOCK {resource}; PUT with and without If; refresh LOCK; UNLOCK",
      assertions: [
        "A new lock returns a DAV:lockdiscovery body and Lock-Token header.",
        "The DAV:owner information from the request is preserved in DAV:lockdiscovery.",
        "An existing exclusive lock prevents a subsequent shared lock without creating another lock.",
        "An unconditioned write fails, while the matching lock token permits it.",
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
      const owner = "urn:cf-r2-webdav:rfc-test:lock-owner";
      const created = await client.request(file, {
        method: "LOCK",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: `<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>${owner}</D:href></D:owner></D:lockinfo>`,
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
      assert.equal(
        requiredChild(
          requiredChild(activeLock, DAV_NAMESPACE, "owner"),
          DAV_NAMESPACE,
          "href",
        ).textContent,
        owner,
      );

      const conflicting = await client.request(file, {
        method: "LOCK",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
      });
      assert.ok(
        !conflicting.ok,
        `A shared LOCK succeeded despite the exclusive lock: ${conflicting.status}`,
      );
      const lockDiscovery = await propfind(
        client,
        file,
        propfindBody("<D:lockdiscovery/>"),
      );
      await assertStatus(lockDiscovery, 207);
      const lockItem = responseForPath(
        parseDavMultiStatus(await lockDiscovery.text()),
        client,
        file,
      );
      assert.equal(
        requiredProperty(
          lockItem.propstats,
          DAV_NAMESPACE,
          "lockdiscovery",
        ).getElementsByTagNameNS(DAV_NAMESPACE, "activelock").length,
        1,
      );

      const blocked = await client.request(file, {
        method: "PUT",
        body: "blocked",
      });
      assert.ok(
        !blocked.ok,
        `Unconditioned PUT succeeded despite the lock: ${blocked.status}`,
      );
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
      id: "RFC4918-09.10-002",
      rfc: "4918",
      section: "9.10.1, 9.10.4",
      requirement: "MUST",
      title: "LOCK exposes an unmapped target in its parent collection",
      prerequisites: [
        "A parent collection exists and the authenticated principal can successfully lock an unmapped target in it.",
      ],
      request: "LOCK {unmapped-resource}; Depth: 0; DAV:lockinfo",
      assertions: [
        "The successful LOCK response has a Lock-Token header.",
        "A depth-1 PROPFIND of the parent collection includes the locked target.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("lock-unmapped");
      const resource = `${collection}empty.txt`;
      const locked = await client.request(resource, {
        method: "LOCK",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
      });
      assert.ok(locked.ok, `LOCK returned ${locked.status}`);
      assert.ok(locked.headers.get("Lock-Token"));

      const discovered = await propfind(
        client,
        collection,
        propfindBody("<D:resourcetype/>"),
        "1",
      );
      await assertStatus(discovered, 207);
      responseForPath(
        parseDavMultiStatus(await discovered.text()),
        client,
        resource,
      );
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.10-003",
      rfc: "4918",
      section: "7.4, 9.10.2",
      requirement: "MUST",
      title: "LOCK refresh ignores the Depth header",
      prerequisites: [
        "An unlocked collection has an existing non-collection member.",
      ],
      request:
        "LOCK {collection}; Depth: 0, then refresh with Depth: infinity and write its member",
      assertions: [
        "The refresh succeeds despite its Depth header.",
        "The member remains writable without the collection lock token.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("lock-refresh-depth");
      const member = await client.createFile(
        collection,
        "member.txt",
        "before",
      );
      const locked = await client.request(collection, {
        method: "LOCK",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
      });
      assert.ok(locked.ok, `LOCK returned ${locked.status}`);
      const lockToken = locked.headers.get("Lock-Token");
      assert.ok(lockToken, "LOCK response is missing Lock-Token");

      const refreshed = await client.request(collection, {
        method: "LOCK",
        headers: { If: `(${lockToken})`, Depth: "infinity" },
      });
      assert.ok(refreshed.ok, `LOCK refresh returned ${refreshed.status}`);

      const written = await client.request(member, {
        method: "PUT",
        body: "after",
      });
      assert.ok(
        written.ok,
        `Collection lock refresh protected its member: ${written.status}`,
      );
    },
  );

  rfcTest(
    {
      id: "RFC4918-06.5-001",
      rfc: "4918",
      section: "6.5, 9.10.1",
      requirement: "MUST",
      title: "Distinct new locks receive different lock tokens",
      prerequisites: [
        "Two unlocked non-collection resources exist and the authenticated principal can create exclusive write locks on them.",
      ],
      request: "LOCK {first-resource}, then LOCK {second-resource}",
      assertions: [
        "Each new lock response has a Lock-Token header.",
        "The two lock token values differ.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("lock-token-unique");
      const first = await client.createFile(collection, "first.txt", "first");
      const second = await client.createFile(
        collection,
        "second.txt",
        "second",
      );
      const firstLock = await client.request(first, {
        method: "LOCK",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
      });
      assert.ok(firstLock.ok, `LOCK returned ${firstLock.status}`);
      const firstToken = firstLock.headers.get("Lock-Token");
      assert.ok(firstToken, "First LOCK response is missing Lock-Token");

      const secondLock = await client.request(second, {
        method: "LOCK",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
      });
      assert.ok(secondLock.ok, `LOCK returned ${secondLock.status}`);
      const secondToken = secondLock.headers.get("Lock-Token");
      assert.ok(secondToken, "Second LOCK response is missing Lock-Token");
      assert.notEqual(firstToken, secondToken, "LOCK tokens are not unique");
    },
  );

  rfcTest(
    {
      id: "RFC4918-07.4-001",
      rfc: "4918",
      section: "6.1, 7, 7.5, 9.10.3",
      requirement: "MUST",
      title: "An infinite-depth collection lock protects its members",
      prerequisites: [
        "An unlocked collection has a non-collection member and the authenticated principal can create a write lock.",
      ],
      request:
        "LOCK {collection}; Depth: infinity; then PUT {member} with and without the lock token",
      assertions: [
        "A member write without the lock token fails.",
        "The parent collection lock token permits the member write.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("lock-infinite");
      const member = await client.createFile(
        collection,
        "member.txt",
        "before",
      );
      const locked = await client.request(collection, {
        method: "LOCK",
        headers: { "Content-Type": "application/xml", Depth: "infinity" },
        body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
      });
      assert.ok(locked.ok, `LOCK returned ${locked.status}`);
      const lockToken = locked.headers.get("Lock-Token");
      assert.ok(lockToken, "LOCK response is missing Lock-Token");
      assert.match(
        lockToken,
        /^<[^>]+>$/,
        "LOCK did not return one lock token",
      );

      const blocked = await client.request(member, {
        method: "PUT",
        body: "blocked",
      });
      assert.ok(
        !blocked.ok,
        `Member PUT succeeded without the collection lock token: ${blocked.status}`,
      );
      const permitted = await client.request(member, {
        method: "PUT",
        headers: { If: `(${lockToken})` },
        body: "permitted",
      });
      assert.ok(
        permitted.ok,
        `Member PUT with collection lock token returned ${permitted.status}`,
      );
    },
  );

  rfcTest(
    {
      id: "RFC4918-06.1-001",
      rfc: "4918",
      section: "6.1, 7.5",
      requirement: "MUST",
      title: "Deleting a lock root invalidates its lock token",
      prerequisites: [
        "An unlocked non-collection resource exists and the authenticated principal can create a write lock.",
      ],
      request:
        "LOCK {resource}; DELETE with its If token; recreate the resource; refresh with the old token",
      assertions: [
        "The resource can be recreated without the deleted lock token.",
        "The old lock token cannot refresh a lock on the recreated resource.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("delete-lock-root");
      const resource = await client.createFile(
        collection,
        "document.txt",
        "body",
      );
      const locked = await client.request(resource, {
        method: "LOCK",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
      });
      assert.ok(locked.ok, `LOCK returned ${locked.status}`);
      const lockToken = locked.headers.get("Lock-Token");
      assert.ok(lockToken, "LOCK response is missing Lock-Token");

      const deleted = await client.request(resource, {
        method: "DELETE",
        headers: { If: `(${lockToken})` },
      });
      assert.ok(deleted.ok, `DELETE returned ${deleted.status}`);
      const recreated = await client.request(resource, {
        method: "PUT",
        body: "recreated",
      });
      assert.ok(
        recreated.ok,
        `Recreating the deleted lock root returned ${recreated.status}`,
      );
      const refreshed = await client.request(resource, {
        method: "LOCK",
        headers: { If: `(${lockToken})` },
      });
      assert.ok(
        !refreshed.ok,
        `Deleted lock token refreshed successfully: ${refreshed.status}`,
      );
    },
  );

  rfcTest(
    {
      id: "RFC4918-09.11-001",
      rfc: "4918",
      section: "9.11, 9.11.1",
      requirement: "MUST",
      title: "UNLOCK rejects a request without a lock token",
      prerequisites: ["A WebDAV resource exists."],
      request: "UNLOCK {resource}; Lock-Token omitted",
      assertions: ["The response is 400."],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("unlock-without-token");
      const file = await client.createFile(collection, "document.txt", "body");
      const response = await client.request(file, { method: "UNLOCK" });
      await assertStatus(response, 400);
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

  rfcTest(
    {
      id: "RFC4918-10.4-003",
      rfc: "4918",
      section: "10.4.3, 10.4.4, 10.4.8",
      requirement: "MUST",
      title: "If evaluates DAV:no-lock condition lists",
      prerequisites: [
        "A parent collection exists and two child request targets are unmapped.",
      ],
      request:
        "PUT unmapped resources with false DAV:no-lock, an OR list, and an AND list",
      assertions: [
        "A false DAV:no-lock condition is rejected with 412 without creating the resource.",
        "A true condition list permits the request even when another list is false.",
        "A false condition within a list makes that list false and the request is rejected with 412.",
        "The rejected PUT does not create the resource.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("if-condition-lists");
      const falsePath = `${collection}false.txt`;
      const permittedPath = `${collection}permitted.txt`;
      const rejectedPath = `${collection}rejected.txt`;

      const falseCondition = await client.request(falsePath, {
        method: "PUT",
        headers: { If: "(<DAV:no-lock>)" },
        body: "must-not-be-created",
      });
      await assertStatus(falseCondition, 412);
      const falseFound = await client.request(falsePath, { method: "GET" });
      await assertStatus(falseFound, 404);

      const permitted = await client.request(permittedPath, {
        method: "PUT",
        headers: { If: "(<DAV:no-lock>) (Not <DAV:no-lock>)" },
        body: "permitted",
      });
      await assertStatus(permitted, 201);

      const rejected = await client.request(rejectedPath, {
        method: "PUT",
        headers: { If: "(Not <DAV:no-lock> <DAV:no-lock>)" },
        body: "rejected",
      });
      await assertStatus(rejected, 412);

      const found = await client.request(rejectedPath, { method: "GET" });
      await assertStatus(found, 404);
    },
  );

  rfcTest(
    {
      id: "RFC4918-14.24-001",
      rfc: "4918",
      section: "8.3, 13, 14.7, 14.24",
      requirement: "MUST NOT",
      title: "Multi-Status DAV:href values are well formed and consistent",
      prerequisites: ["A collection has an immediate member."],
      request: "PROPFIND {collection}; Depth: 1; DAV:prop(resourcetype)",
      assertions: [
        "Every DAV:response contains a DAV:href with a URI or relative-reference value.",
        "No DAV:response contains the same DAV:href value more than once.",
        "All DAV:href values use one reference format, match the request URI prefix, and contain no fragment or dot-segment.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("response-href");
      await client.createFile(collection, "document.txt", "body");
      const response = await propfind(
        client,
        collection,
        propfindBody("<D:resourcetype/>"),
        "1",
      );
      await assertStatus(response, 207);
      const root = parseXml(await response.text());
      assertElement(root, DAV_NAMESPACE, "multistatus");
      const responses = Array.from(root.children).filter(
        (candidate) =>
          candidate.namespaceURI === DAV_NAMESPACE &&
          candidate.localName === "response",
      );
      assert.ok(responses.length > 0, "Response has no DAV:response");
      for (const item of responses) {
        const hrefs = Array.from(item.children)
          .filter(
            (candidate) =>
              candidate.namespaceURI === DAV_NAMESPACE &&
              candidate.localName === "href",
          )
          .map((href) => href.textContent ?? "");
        assert.ok(hrefs.length > 0, "A DAV:response has no DAV:href");
        for (const href of hrefs) {
          assert.doesNotThrow(
            () => new URL(href, client.origin),
            `DAV:href is not a URI or relative reference: ${href}`,
          );
        }
        assert.equal(
          new Set(hrefs).size,
          hrefs.length,
          "A DAV:response repeats a DAV:href value",
        );
      }
      const hrefs = Array.from(
        root.getElementsByTagNameNS(DAV_NAMESPACE, "href"),
      ).map((href) => href.textContent ?? "");
      const requestUrl = new URL(collection, client.origin);
      const formats = new Set<string>();
      for (const href of hrefs) {
        assert.ok(!href.includes("#"), `DAV:href has a fragment: ${href}`);
        const rawPath = href.split(/[?#]/, 1)[0];
        assert.doesNotMatch(
          rawPath,
          /\/(?:\.|\.\.)(?:\/|$)/,
          `DAV:href has a dot-segment: ${href}`,
        );
        const resolved = new URL(href, client.origin);
        assert.equal(
          resolved.origin,
          requestUrl.origin,
          `DAV:href does not have the request URI prefix: ${href}`,
        );
        assert.ok(
          resolved.pathname === requestUrl.pathname ||
            resolved.pathname.startsWith(requestUrl.pathname),
          `DAV:href does not have the request URI prefix: ${href}`,
        );
        if (href.startsWith("/")) {
          assert.ok(
            !href.startsWith("//"),
            `DAV:href is not an absolute-path reference: ${href}`,
          );
          formats.add("relative");
          continue;
        }
        assert.doesNotThrow(
          () => new URL(href),
          `DAV:href is not an absolute URI: ${href}`,
        );
        formats.add("absolute");
      }
      assert.equal(
        formats.size,
        1,
        "DAV:href values use inconsistent reference formats",
      );
    },
  );

  rfcTest(
    {
      id: "RFC4918-14.26-001",
      rfc: "4918",
      section: "4.3, 9.2",
      requirement: "MUST",
      title: "PROPPATCH preserves required dead-property XML information",
      prerequisites: [
        "The authenticated principal can set and retrieve an arbitrary dead property on a non-collection resource.",
      ],
      request:
        "PROPPATCH {resource}; DAV:set(T:metadata with xml:lang, xml:space, and a child value element)",
      assertions: [
        "The stored property preserves its xml:lang attribute and ignores xml:space.",
        "The property value preserves its child element namespace, local name, attribute, and character data.",
        "Whitespace in the property value is preserved.",
      ],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection("property-attribute");
      const file = await client.createFile(collection, "document.txt", "body");
      const patched = await proppatch(
        client,
        file,
        proppatchBody(
          '<D:set><D:prop><T:metadata xml:lang="fr" xml:space="default"><T:value T:label="preserved">before</T:value> after </T:metadata></D:prop></D:set>',
        ),
      );
      await assertStatus(patched, 207);
      const found = await propfind(client, file, propfindBody("<T:metadata/>"));
      await assertStatus(found, 207);
      const item = responseForPath(
        parseDavMultiStatus(await found.text()),
        client,
        file,
      );
      assert.equal(
        propertyStatus(item.propstats, TEST_NAMESPACE, "metadata"),
        200,
      );
      const property = requiredProperty(
        item.propstats,
        TEST_NAMESPACE,
        "metadata",
      );
      assert.equal(
        property.getAttributeNS("http://www.w3.org/XML/1998/namespace", "lang"),
        "fr",
      );
      const value = requiredChild(property, TEST_NAMESPACE, "value");
      assert.equal(value.getAttributeNS(TEST_NAMESPACE, "label"), "preserved");
      assert.equal(value.textContent, "before");
      assert.equal(property.textContent, "before after ");
    },
  );
}

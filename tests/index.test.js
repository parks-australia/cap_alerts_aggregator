import { describe, expect, it, vi } from "vitest";
import { setTimeout } from "node:timers/promises";
import {
  extractCanonicalLinks,
  ingestSource,
  normalizeCapXml,
  pollSources,
  reduceAlertLifecycle,
} from "../src/index.js";

const capXml = `<?xml version="1.0"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>sender-1</identifier>
  <sender>sender@example.test</sender>
  <sent>2026-09-21T00:00:00-00:00</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <category>Fire</category>
    <event>Bushfire</event>
    <urgency>Immediate</urgency>
    <severity>Severe</severity>
    <certainty>Observed</certainty>
    <headline>Test alert</headline>
    <expires>2026-09-21T02:00:00+00:00</expires>
  </info>
</alert>`;

describe("CAP ingestion first slice", () => {
  it("extracts RSS canonical links", () => {
    const rss =
      "<rss><channel><item><link>https://example.test/a.xml</link></item></channel></rss>";
    expect(extractCanonicalLinks(rss, "rss")).toEqual([
      "https://example.test/a.xml",
    ]);
  });

  it("extracts Atom canonical links", () => {
    const atom =
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="https://example.test/a.xml" /></entry></feed>';
    expect(extractCanonicalLinks(atom, "atom")).toEqual([
      "https://example.test/a.xml",
    ]);
  });

  it("normalizes a CAP alert and keeps geometry for the next stage", () => {
    const [alert] = normalizeCapXml(capXml, {
      id: "drupal",
      feedUrl: "https://example.test",
    });
    expect(alert.id).toBe("sender-1");
    expect(alert.properties.severity).toBe("Severe");
    expect(alert.properties.source.feedSourceId).toBe("drupal");
    expect(alert.geometry).toBeNull();
  });

  it("removes expired alerts", () => {
    const [alert] = normalizeCapXml(capXml, {
      id: "source",
      feedUrl: "https://example.test",
    });
    expect(
      reduceAlertLifecycle([alert], new Date("2026-09-21T03:00:00Z")),
    ).toEqual([]);
  });

  it("removes an alert referenced by a CAP Cancel message", () => {
    const [alert] = normalizeCapXml(capXml, {
      id: "source",
      feedUrl: "https://example.test",
    });
    const cancel = {
      id: "sender-cancel",
      properties: {
        identifier: "sender-cancel",
        msgType: "Cancel",
        references: "sender@example.test,sender-1,2026-09-21T00:00:00-00:00",
      },
    };
    expect(
      reduceAlertLifecycle([alert, cancel], new Date("2026-09-21T01:00:00Z")),
    ).toEqual([]);
  });

  it("keeps an Update and removes the referenced alert", () => {
    const [alert] = normalizeCapXml(capXml, {
      id: "source",
      feedUrl: "https://example.test",
    });
    const update = {
      id: "sender-update",
      properties: {
        identifier: "sender-update",
        msgType: "Update",
        references: "sender@example.test,sender-1,2026-09-21T00:00:00-00:00",
        expires: "2026-09-21T04:00:00Z",
      },
    };
    expect(
      reduceAlertLifecycle([alert, update], new Date("2026-09-21T01:00:00Z")),
    ).toEqual([update]);
  });

  it("exposes ingested alerts and source errors for local inspection", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === "https://drupal.test/sources") {
        return {
          ok: true,
          json: async () => ({
            sources: [
              {
                id: "cap",
                feedFormat: "cap-xml",
                feedUrl: "https://feed.test/cap.xml",
              },
              {
                id: "unsupported",
                feedFormat: "unsupported-format",
                feedUrl: "https://feed.test/data",
              },
            ],
          }),
        };
      }
      return { ok: true, text: async () => capXml };
    });
    vi.stubGlobal("fetch", fetchMock);

    const output = await pollSources(
      {
        feedSourcesUrl: "https://drupal.test/sources",
        aggregatorSecret: "secret",
      },
      false,
      { includeIngestedAlerts: true },
    );

    expect(output.sources[0].ingestedAlerts).toHaveLength(1);
    expect(output.sources[0].alerts).toHaveLength(0);
    expect(output.sources[0].ingestion.documentCount).toBe(1);
    expect(output.sources[1].status).toBe("degraded");
    expect(output.sources[1].error).toMatch(/Unsupported/);
    vi.unstubAllGlobals();
  });

  it("ingests every authenticated DataQuoll GeoJSON page", async () => {
    const feedUrl = "https://dataquoll.test/api/v1/incidents?state=nsw";
    const cursor = "opaque-next-cursor";
    const page = (id, nextCursor) => ({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        id,
        geometry: { type: "Point", coordinates: [151, -33] },
        properties: {
          source: { state: "nsw", agency: "RFS", feedId: "rfs-feed" },
          title: "Test incident",
          eventType: "bushfire",
          severity: "Severe",
          urgency: "Immediate",
          certainty: "Observed",
          timestamps: { reported: "2026-09-24T00:00:00Z" },
        },
      }],
      meta: { total_count: 2, next_cursor: nextCursor },
      attribution: "https://dataquoll.test/attribution",
    });
    const fetchMock = vi.fn(async (url) => ({
      ok: true,
      text: async () => JSON.stringify(
        String(url).includes("cursor=opaque-next-cursor")
          ? page("incident-2")
          : page("incident-1", cursor),
      ),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ingestion = {};

    const alerts = await ingestSource({
      id: "dataquoll",
      feedFormat: "dataquoll_geojson",
      feedUrl,
      credential: "token",
    }, ingestion);

    expect(alerts.map(({ id }) => id)).toEqual(["incident-1", "incident-2"]);
    expect(alerts[0].properties.source).toEqual({
      feedSourceId: "dataquoll",
      originState: "nsw",
      originAgency: "RFS",
      originFeedId: "rfs-feed",
    });
    expect(ingestion).toMatchObject({ pageCount: 2, totalCount: 2 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://dataquoll.test/api/v1/incidents?state=nsw&limit=500",
      { headers: { authorization: "Bearer token" } },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://dataquoll.test/api/v1/incidents?state=nsw&limit=500&cursor=opaque-next-cursor",
      { headers: { authorization: "Bearer token" } },
    );
    vi.unstubAllGlobals();
  });

  it("sends a source credential to Atom feeds and their canonical CAP documents", async () => {
    const feedUrl = "https://feed.test/alerts.atom";
    const documentUrl = "https://feed.test/alert.xml";
    const atom = `<feed><entry><link href="${documentUrl}" /></entry></feed>`;
    const fetchMock = vi.fn(async (url) => {
      if (url === feedUrl) return { ok: true, text: async () => atom };
      return { ok: true, text: async () => capXml };
    });
    vi.stubGlobal("fetch", fetchMock);

    await ingestSource({
      id: "authenticated-atom",
      feedFormat: "atom",
      feedUrl,
      credential: "dataquoll-token",
    });

    expect(fetchMock).toHaveBeenCalledWith(feedUrl, {
      headers: { authorization: "Bearer dataquoll-token" },
    });
    expect(fetchMock).toHaveBeenCalledWith(documentUrl, {
      headers: { authorization: "Bearer dataquoll-token" },
    });
    vi.unstubAllGlobals();
  });

  it("bounds canonical document fetches and identifies failed links", async () => {
    const links = Array.from(
      { length: 25 },
      (_, index) => `https://feed.test/${index}.xml`,
    );
    const rss = `<rss><channel>${links.map((link) => `<item><link>${link}</link></item>`).join("")}</channel></rss>`;
    let activeFetches = 0;
    let maximumActiveFetches = 0;
    const fetchMock = vi.fn(async (url) => {
      if (url === "https://feed.test/rss.xml") {
        return { ok: true, text: async () => rss };
      }
      activeFetches += 1;
      maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
      await setTimeout(1);
      activeFetches -= 1;
      if (url === links[7]) throw new TypeError("fetch failed");
      return { ok: true, text: async () => capXml };
    });
    vi.stubGlobal("fetch", fetchMock);
    const ingestion = {};

    await expect(
      ingestSource(
        {
          id: "large-rss",
          feedFormat: "rss",
          feedUrl: "https://feed.test/rss.xml",
        },
        ingestion,
      ),
    ).rejects.toThrow(`${links[7]}: fetch failed`);

    expect(maximumActiveFetches).toBeLessThanOrEqual(10);
    expect(ingestion.canonicalLinkCount).toBe(25);
    expect(ingestion.documentCount).toBe(24);
    expect(ingestion.failedDocumentCount).toBe(1);
    expect(ingestion.documentErrors).toEqual([
      { url: links[7], error: "fetch failed" },
    ]);
    vi.unstubAllGlobals();
  });
});

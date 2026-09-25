import { URL } from "node:url";

const maximumPages = 100;

export async function ingestDataQuollGeoJson(source, ingestion, { fetchJson }) {
  const url = new URL(source.feedUrl);
  if (url.searchParams.has("format") && url.searchParams.get("format") !== "geojson") {
    throw new Error("DataQuoll GeoJSON sources must not request a non-GeoJSON format");
  }
  if (!url.searchParams.has("limit")) url.searchParams.set("limit", "500");

  const features = [];
  const seenCursors = new Set();
  let nextCursor;
  let pageCount = 0;

  do {
    if (pageCount >= maximumPages) {
      throw new Error(`DataQuoll pagination exceeded ${maximumPages} pages`);
    }
    if (nextCursor) {
      if (seenCursors.has(nextCursor)) {
        throw new Error("DataQuoll pagination returned a repeated cursor");
      }
      seenCursors.add(nextCursor);
      url.searchParams.set("cursor", nextCursor);
    }

    const { body } = await fetchJson(url, source, ingestion);
    validatePage(body);
    features.push(...body.features.map((feature) => normalizeFeature(feature, source)));
    pageCount += 1;
    nextCursor = body.meta?.next_cursor;
    if (ingestion) {
      ingestion.totalCount = body.meta?.total_count;
      ingestion.dataGeneratedAt = body.meta?.generatedAt;
      ingestion.attribution = body.attribution;
    }
  } while (nextCursor);

  if (ingestion) {
    ingestion.pageCount = pageCount;
    ingestion.documentCount = pageCount;
  }
  return features;
}

function validatePage(page) {
  if (page?.type !== "FeatureCollection" || !Array.isArray(page.features)) {
    throw new Error("DataQuoll response was not an incident FeatureCollection");
  }
}

function normalizeFeature(feature, source) {
  if (
    feature?.type !== "Feature" ||
    !feature.id ||
    !["Point", "Polygon", "MultiPolygon"].includes(feature.geometry?.type)
  ) {
    throw new Error("DataQuoll incident was missing a stable ID or supported geometry");
  }
  const properties = feature.properties ?? {};
  const origin = properties.source ?? {};
  return {
    type: "Feature",
    id: feature.id,
    geometry: feature.geometry,
    properties: {
      source: {
        feedSourceId: source.id,
        originState: origin.state,
        originAgency: origin.agency,
        originFeedId: origin.feedId,
      },
      identifier: feature.id,
      sender: origin.agency,
      status: properties.status,
      sent: properties.timestamps?.reported,
      effective: properties.timestamps?.updated,
      expires: properties.details?.expires,
      event: properties.eventType,
      headline: properties.title,
      description: properties.details?.description,
      severity: properties.severity,
      certainty: properties.certainty,
      urgency: properties.urgency,
      warningLevel: properties.warningLevel,
      featureType: properties.featureType,
      location: properties.location,
      fetched: properties.timestamps?.fetched,
      retracted: properties.retraction?.retracted === true,
      retractedAt: properties.retraction?.retractedAt,
      retractionReason: properties.retraction?.reason,
      link: source.feedUrl,
    },
  };
}
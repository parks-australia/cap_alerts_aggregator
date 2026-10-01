import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  assignFeaturesToParks,
  buildParkOutputs,
  capAreaGeometry,
  loadBoundaries,
  parseCapCircle,
  parseCapPolygon,
} from "../src/geometry.js";
import { point, polygon } from "@turf/helpers";

const schema = JSON.parse(
  readFileSync(new URL("../schemas/park-alerts-v1.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const validateParkOutput = ajv.compile(schema);

describe("CAP geometry normalization", () => {
  it("parses CAP polygon coordinates into GeoJSON longitude/latitude order", () => {
    expect(parseCapPolygon("-35.2,149.0 -35.2,149.1 -35.3,149.1")).toEqual([
      [149, -35.2],
      [149.1, -35.2],
      [149.1, -35.3],
      [149, -35.2],
    ]);
  });

  it("parses CAP circles", () => {
    expect(parseCapCircle("-35.2,149.0 5")).toEqual({
      latitude: -35.2,
      longitude: 149,
      radiusKm: 5,
    });
  });

  it("rejects out-of-range circles and preserves zero-radius points", () => {
    expect(parseCapCircle("132.758582,-13.427191 50")).toBeNull();
    expect(
      capAreaGeometry({ circle: "-19.046704,136.361083 0" })[0].geometry.type,
    ).toBe("Point");
  });

  it("rejects circles with a radius greater than that of the earth", () => {
    expect(parseCapCircle("-13.427191,132.758582 6373")).toBeNull();
  });

  it("converts polygon and circle areas to geometry features", () => {
    const geometries = capAreaGeometry({
      polygon: "-35.2,149.0 -35.2,149.1 -35.3,149.1",
      circle: "-35.2,149.0 5",
    });
    expect(geometries).toHaveLength(2);
    expect(geometries[0].geometry.type).toBe("Polygon");
    expect(geometries[1].geometry.type).toBe("Polygon");
  });

  it("duplicates an intersecting alert into every matching park", () => {
    const alert = polygon(
      [
        [
          [149, -35.2],
          [149.1, -35.2],
          [149.1, -35.3],
          [149, -35.3],
          [149, -35.2],
        ],
      ],
      { identifier: "alert-1" },
    );
    const boundaries = {
      parkA: polygon([
        [
          [148.9, -35.1],
          [149.05, -35.1],
          [149.05, -35.35],
          [148.9, -35.35],
          [148.9, -35.1],
        ],
      ]),
      parkB: polygon([
        [
          [149.05, -35.1],
          [149.2, -35.1],
          [149.2, -35.35],
          [149.05, -35.35],
          [149.05, -35.1],
        ],
      ]),
    };
    const assigned = assignFeaturesToParks([alert], boundaries);
    expect(assigned.parkA).toHaveLength(1);
    expect(assigned.parkB).toHaveLength(1);
  });

  it("never lets an explicit park assignment bypass geometry matching", () => {
    const boundaries = {
      parkA: polygon([[[0, 0], [1, 0], [1, 1], [0, 0]]]),
      parkB: polygon([[[10, 10], [11, 10], [11, 11], [10, 10]]]),
    };
    const outsideSelectedPark = point([10.5, 10.5], { parkIds: ["parkA"] });
    const insideSelectedPark = point([0.5, 0.25], { parkIds: ["parkA"] });

    const assigned = assignFeaturesToParks(
      [outsideSelectedPark, insideSelectedPark],
      boundaries,
    );

    expect(assigned.parkA).toEqual([insideSelectedPark]);
    expect(assigned.parkB).toEqual([]);
  });

  it("uses explicit park assignment only when geometry is absent", () => {
    const alert = {
      type: "Feature",
      id: "geometry-less",
      geometry: null,
      properties: { parkIds: ["parkA"] },
    };
    const assigned = assignFeaturesToParks([alert], {
      parkA: polygon([[[0, 0], [1, 0], [1, 1], [0, 0]]]),
    });

    expect(assigned.parkA).toEqual([alert]);
  });

  it("builds a per-park FeatureCollection output", () => {
    const alert = polygon(
      [
        [
          [149, -35.2],
          [149.1, -35.2],
          [149.1, -35.3],
          [149, -35.3],
          [149, -35.2],
        ],
      ],
      { identifier: "alert-1" },
    );
    const outputs = buildParkOutputs(
      [alert],
      {
        parkA: polygon([
          [
            [148.9, -35.1],
            [149.2, -35.1],
            [149.2, -35.4],
            [148.9, -35.4],
            [148.9, -35.1],
          ],
        ]),
      },
      "2026-09-21T00:00:00.000Z",
    );
    expect(outputs.parkA).toMatchObject({
      type: "FeatureCollection",
      schemaVersion: 1,
      park: "parkA",
      generatedAt: "2026-09-21T00:00:00.000Z",
    });
    expect(outputs.parkA.features).toHaveLength(1);
  });

  it("deduplicates per-park alerts by identifier and sender across sources", () => {
    const alert = (identifier, sender, feedSourceId) => ({
      type: "Feature",
      id: identifier,
      geometry: null,
      properties: {
        identifier,
        sender,
        parkIds: ["parkA"],
        source: { feedSourceId },
      },
    });
    const outputs = buildParkOutputs(
      [
        alert("alert-1", "sender@example.test", "rss-source"),
        alert("alert-1", "sender@example.test", "cap-xml-source"),
        alert("alert-1", "other@example.test", "other-sender-source"),
        alert("alert-2", "sender@example.test", "other-alert-source"),
      ],
      { parkA: polygon([[[0, 0], [1, 0], [1, 1], [0, 0]]]) },
      "2026-10-01T00:00:00.000Z",
      new Map([
        ["rss-source", {}],
        ["cap-xml-source", {}],
        ["other-sender-source", {}],
        ["other-alert-source", {}],
      ]),
    );

    expect(outputs.parkA.features.map((feature) => [
      feature.properties.identifier,
      feature.properties.sender,
      feature.properties.source.feedSourceId,
    ])).toEqual([
      ["alert-1", "sender@example.test", "rss-source"],
      ["alert-1", "other@example.test", "other-sender-source"],
      ["alert-2", "sender@example.test", "other-alert-source"],
    ]);
  });

  it("publishes source health and attribution metadata", () => {
    const alert = point([10.5, 10.25], {
      source: { feedSourceId: "dataquoll" },
      sourceType: "dataquoll-geojson",
      identifier: "incident-1",
      locationIds: [],
      parkIds: ["parkA"],
      degraded: false,
    });
    alert.id = "incident-1";
    const outputs = buildParkOutputs(
      [alert],
      { parkA: polygon([[[10, 10], [11, 10], [11, 11], [10, 10]]]) },
      "2026-09-28T00:00:00.000Z",
      new Map([["dataquoll", {}]]),
      [{
        id: "dataquoll",
        status: "ok",
        lastSuccess: "2026-09-28T00:00:00.000Z",
        ingestion: { attribution: "https://example.test/attribution" },
      }],
    );

    expect(outputs.parkA.sources).toEqual([{
      id: "dataquoll",
      status: "ok",
      lastSuccess: "2026-09-28T00:00:00.000Z",
    }]);
    expect(outputs.parkA.attribution).toEqual(["https://example.test/attribution"]);
    expect(outputs.parkA.features).toHaveLength(1);
    expect(
      validateParkOutput(outputs.parkA),
      JSON.stringify(validateParkOutput.errors),
    ).toBe(true);
  });

  it("loads and culls against the supplied anbg and bnp boundary assets", async () => {
    const boundaries = await loadBoundaries(resolve("assets/boundary_data"));
    expect(Object.keys(boundaries).sort()).toEqual([
      "anbg",
      "bnp",
      "cinp",
      "knp",
      "ninp",
      "pknp",
      "uktnp",
    ]);
    const coordinateFromFeature = (feature) => {
      const coordinates = feature.geometry.coordinates;
      return feature.geometry.type === "MultiPolygon"
        ? coordinates[0][0][0]
        : coordinates[0][0];
    };
    const anbgCoordinate = coordinateFromFeature(boundaries.anbg.features[0]);
    const bnpCoordinate = coordinateFromFeature(boundaries.bnp.features[0]);
    const assigned = assignFeaturesToParks(
      [
        point(anbgCoordinate, { identifier: "anbg-test" }),
        point(bnpCoordinate, { identifier: "bnp-test" }),
      ],
      boundaries,
    );

    expect(assigned.anbg).toHaveLength(1);
    expect(assigned.bnp).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  assignFeaturesToParks,
  buildParkOutputs,
  capAreaGeometry,
  loadBoundaries,
  parseCapCircle,
  parseCapPolygon,
} from "../src/geometry.js";
import { point, polygon } from "@turf/helpers";

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

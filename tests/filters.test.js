import { describe, expect, it } from "vitest";
import { point } from "@turf/helpers";
import { filterParkFeatures, filterSourceFeatures } from "../src/filters.js";

function feature(id, properties = {}, geometry = point([149, -35]).geometry) {
  return {
    type: "Feature",
    id,
    geometry,
    properties: {
      source: { feedSourceId: "source-a" },
      severity: "Moderate",
      certainty: "Observed",
      urgency: "Expected",
      category: ["Fire"],
      sender: "RFS",
      msgType: "Alert",
      ...properties,
    },
  };
}

describe("CAP source filters", () => {
  it("applies CAP thresholds, lists, and geometry requirements", () => {
    const source = {
      minSeverity: "Moderate",
      minCertainty: "Likely",
      minUrgency: "Expected",
      categoryAllowlist: ["Fire"],
      agencyAllowlist: ["RFS"],
      msgtypeDenylist: ["Update"],
      requireGeometry: true,
    };
    const features = [
      feature("include"),
      feature("minor", { severity: "Minor" }),
      feature("agency", { sender: "SES" }),
      feature("update", { msgType: "Update" }),
      feature("no-geometry", {}, null),
    ];

    expect(filterSourceFeatures(features, source).map(({ id }) => id)).toEqual([
      "include",
    ]);
  });

  it("replaces base filters with a matching park override only", () => {
    const source = {
      minSeverity: "Severe",
      parkOverrides: [
        { parkId: "permissive-park", minSeverity: "Minor" },
      ],
    };
    const sourceConfigs = new Map([["source-a", source]]);
    const features = [
      feature("minor", { severity: "Minor" }),
      feature("severe", { severity: "Severe" }),
    ];

    expect(
      filterParkFeatures(features, "permissive-park", sourceConfigs).map(
        ({ id }) => id,
      ),
    ).toEqual(["minor", "severe"]);
    expect(
      filterParkFeatures(features, "other-park", sourceConfigs).map(({ id }) => id),
    ).toEqual(["severe"]);
  });

  it("inherits a source threshold when the park override field is blank", () => {
    const source = {
      minSeverity: "Severe",
      parkOverrides: [{ parkId: "knp", minSeverity: "" }],
    };
    const sourceConfigs = new Map([["source-a", source]]);
    const features = [
      feature("moderate", { severity: "Moderate" }),
      feature("severe", { severity: "Severe" }),
    ];

    expect(
      filterParkFeatures(features, "knp", sourceConfigs).map(({ id }) => id),
    ).toEqual(["severe"]);
  });
});
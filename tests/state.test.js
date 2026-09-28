import { describe, expect, it } from "vitest";
import {
  degradedFeatures,
  DynamoAlertStateStore,
  healthChanged,
  reconcileAlertState,
} from "../src/state.js";

const feature = (identifier, properties = {}) => ({
  type: "Feature",
  id: identifier,
  geometry: null,
  properties: { identifier, degraded: false, ...properties },
});

const record = (identifier, missedPolls = 0, properties = {}) => ({
  identifier,
  missedPolls,
  feature: feature(identifier, properties),
});

describe("persistent alert lifecycle state", () => {
  it("retains an alert for one successful missed poll and removes it on the second", () => {
    const firstMiss = reconcileAlertState([record("alert-1")], []);
    expect(firstMiss.records).toMatchObject([{ identifier: "alert-1", missedPolls: 1 }]);
    expect(firstMiss.deletedIds).toEqual([]);

    const secondMiss = reconcileAlertState(firstMiss.records, []);
    expect(secondMiss.records).toEqual([]);
    expect(secondMiss.deletedIds).toEqual(["alert-1"]);
  });

  it("resets the missed-poll count when an alert returns", () => {
    const current = feature("alert-1", { headline: "Updated" });
    const result = reconcileAlertState([record("alert-1", 1)], [current]);

    expect(result.records).toEqual([{
      identifier: "alert-1",
      feature: current,
      missedPolls: 0,
    }]);
  });

  it("does not rewrite an unchanged record with a healthy rolling TTL", () => {
    const existing = {
      ...record("alert-1"),
      stateExpiresAt: Math.floor(new Date("2026-10-04T00:00:00Z").valueOf() / 1000),
    };
    const result = reconcileAlertState(
      [existing],
      [existing.feature],
      { now: new Date("2026-09-28T00:00:00Z") },
    );

    expect(result.records).toHaveLength(1);
    expect(result.upsertRecords).toEqual([]);
  });

  it("removes explicit cancellations and expired cached alerts immediately", () => {
    const result = reconcileAlertState(
      [
        record("cancelled"),
        record("expired", 0, { expires: "2026-09-27T00:00:00Z" }),
      ],
      [],
      {
        immediatelyRemovedIds: ["cancelled"],
        now: new Date("2026-09-28T00:00:00Z"),
      },
    );

    expect(result.records).toEqual([]);
    expect(result.deletedIds).toEqual(["cancelled", "expired"]);
  });

  it("marks recovered last-known-good features as degraded without mutating state", () => {
    const previous = record("alert-1");
    const recovered = degradedFeatures([previous]);

    expect(recovered[0].properties.degraded).toBe(true);
    expect(previous.feature.properties.degraded).toBe(false);
  });

  it("detects only initial or changed source health results", () => {
    expect(healthChanged({ status: null, error: null }, "ok")).toBe(true);
    expect(healthChanged({ status: "ok", error: null }, "ok")).toBe(false);
    expect(healthChanged(
      { status: "degraded", error: "timeout" },
      "degraded",
      "timeout",
    )).toBe(false);
    expect(healthChanged(
      { status: "degraded", error: "timeout" },
      "degraded",
      "HTTP 500",
    )).toBe(true);
  });

  it("loads paginated alert records and persists batched state", async () => {
    const sent = [];
    const client = {
      send: async (command) => {
        sent.push(command);
        if (command.constructor.name === "QueryCommand") {
          return {
            Items: [
              {
                source_id: { S: "source-1" },
                record_key: { S: "METADATA" },
                status: { S: "degraded" },
                error: { S: "timeout" },
                last_success: { S: "2026-09-27T00:00:00.000Z" },
              },
              {
                source_id: { S: "source-1" },
                record_key: { S: "ALERT#alert-1" },
                identifier: { S: "alert-1" },
                feature_json: { S: JSON.stringify(feature("alert-1")) },
                missed_polls: { N: "1" },
              },
            ],
          };
        }
        return {};
      },
    };
    const store = new DynamoAlertStateStore(client, "state-table");

    const loaded = await store.load("source-1");
    expect(loaded).toMatchObject({
      status: "degraded",
      error: "timeout",
      lastSuccess: "2026-09-27T00:00:00.000Z",
      records: [{ identifier: "alert-1", missedPolls: 1 }],
    });

    await store.saveSuccess("source-1", {
      records: [record("alert-1")],
      upsertRecords: [record("alert-1")],
      deletedIds: ["alert-2"],
    }, "2026-09-28T00:00:00.000Z");

    const batch = sent.find((command) => command.constructor.name === "BatchWriteItemCommand");
    expect(batch.input.RequestItems["state-table"]).toHaveLength(2);
    const metadata = sent.at(-1);
    expect(metadata.input.Item).toMatchObject({
      source_id: { S: "source-1" },
      record_key: { S: "METADATA" },
      status: { S: "ok" },
      last_success: { S: "2026-09-28T00:00:00.000Z" },
    });
  });
});

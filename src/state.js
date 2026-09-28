import {
  BatchWriteItemCommand,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";

const metadataKey = "METADATA";
const alertKeyPrefix = "ALERT#";
const batchWriteLimit = 25;
const fallbackRetentionSeconds = 7 * 24 * 60 * 60;
const ttlRefreshWindowSeconds = 24 * 60 * 60;

export class DynamoAlertStateStore {
  constructor(client, tableName) {
    this.client = client;
    this.tableName = tableName;
  }

  async load(sourceId) {
    const items = [];
    let exclusiveStartKey;
    do {
      const response = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "source_id = :source_id",
        ExpressionAttributeValues: { ":source_id": { S: sourceId } },
        ExclusiveStartKey: exclusiveStartKey,
      }));
      items.push(...(response.Items ?? []));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);

    const metadata = items.find((item) => item.record_key?.S === metadataKey);
    return {
      lastSuccess: metadata?.last_success?.S ?? null,
      status: metadata?.status?.S ?? null,
      error: metadata?.error?.S ?? null,
      records: items
        .filter((item) => item.record_key?.S?.startsWith(alertKeyPrefix))
        .map((item) => ({
          identifier: item.identifier.S,
          feature: JSON.parse(item.feature_json.S),
          missedPolls: Number(item.missed_polls?.N ?? 0),
          stateExpiresAt: Number(item.expires_at?.N ?? 0) || null,
        })),
    };
  }

  async saveSuccess(sourceId, reconciliation, timestamp) {
    const requests = [
      ...reconciliation.upsertRecords.map((record) => ({
        PutRequest: {
          Item: alertItem(sourceId, record, timestamp),
        },
      })),
      ...reconciliation.deletedIds.map((identifier) => ({
        DeleteRequest: {
          Key: stateKey(sourceId, alertRecordKey(identifier)),
        },
      })),
    ];
    await this.writeBatches(requests);
    await this.client.send(new PutItemCommand({
      TableName: this.tableName,
      Item: {
        ...stateKey(sourceId, metadataKey),
        status: { S: "ok" },
        alert_count: { N: String(reconciliation.records.length) },
        last_success: { S: timestamp },
        updated_at: { S: timestamp },
      },
    }));
  }

  async saveFailure(sourceId, error, timestamp, previousState) {
    const item = {
      ...stateKey(sourceId, metadataKey),
      status: { S: "degraded" },
      alert_count: { N: String(previousState.records.length) },
      error: { S: error.slice(0, 1000) },
      updated_at: { S: timestamp },
    };
    if (previousState.lastSuccess) {
      item.last_success = { S: previousState.lastSuccess };
    }
    await this.client.send(new PutItemCommand({
      TableName: this.tableName,
      Item: item,
    }));
  }

  async writeBatches(requests) {
    for (let index = 0; index < requests.length; index += batchWriteLimit) {
      let pending = requests.slice(index, index + batchWriteLimit);
      do {
        const response = await this.client.send(new BatchWriteItemCommand({
          RequestItems: { [this.tableName]: pending },
        }));
        pending = response.UnprocessedItems?.[this.tableName] ?? [];
      } while (pending.length);
    }
  }
}

export function reconcileAlertState(
  previousRecords,
  currentFeatures,
  { immediatelyRemovedIds = [], now = new Date() } = {},
) {
  const currentById = new Map(
    currentFeatures.map((feature) => [featureId(feature), feature]),
  );
  const removed = new Set(immediatelyRemovedIds.map(String));
  const records = [];
  const upsertRecords = [];
  const deletedIds = [];
  const nowSeconds = Math.floor(now.valueOf() / 1000);

  for (const record of previousRecords) {
    const identifier = String(record.identifier);
    if (removed.has(identifier)) {
      deletedIds.push(identifier);
      continue;
    }

    const current = currentById.get(identifier);
    if (current) {
      const currentRecord = { identifier, feature: current, missedPolls: 0 };
      records.push(currentRecord);
      if (
        record.missedPolls !== 0
        || JSON.stringify(record.feature) !== JSON.stringify(current)
        || shouldRefreshTtl(record, nowSeconds)
      ) {
        upsertRecords.push(currentRecord);
      }
      currentById.delete(identifier);
      continue;
    }

    if (isExpired(record.feature, now) || (record.missedPolls ?? 0) + 1 >= 2) {
      deletedIds.push(identifier);
      continue;
    }

    const missedRecord = {
      identifier,
      feature: record.feature,
      missedPolls: (record.missedPolls ?? 0) + 1,
    };
    records.push(missedRecord);
    upsertRecords.push(missedRecord);
  }

  for (const [identifier, feature] of currentById) {
    const newRecord = { identifier, feature, missedPolls: 0 };
    records.push(newRecord);
    upsertRecords.push(newRecord);
  }

  return {
    records,
    upsertRecords,
    deletedIds,
    features: records.map(({ feature }) => feature),
  };
}

function shouldRefreshTtl(record, nowSeconds) {
  return !record.feature?.properties?.expires
    && (!record.stateExpiresAt
      || record.stateExpiresAt <= nowSeconds + ttlRefreshWindowSeconds);
}

function alertItem(sourceId, record, timestamp) {
  const item = {
    ...stateKey(sourceId, alertRecordKey(record.identifier)),
    identifier: { S: record.identifier },
    feature_json: { S: JSON.stringify(record.feature) },
    missed_polls: { N: String(record.missedPolls) },
    updated_at: { S: timestamp },
  };
  const expires = new Date(record.feature?.properties?.expires);
  const updatedAtSeconds = Math.floor(new Date(timestamp).valueOf() / 1000);
  const expiresAt = Number.isNaN(expires.valueOf())
    ? updatedAtSeconds + fallbackRetentionSeconds
    : Math.floor(expires.valueOf() / 1000);
  item.expires_at = { N: String(expiresAt) };
  return item;
}

function stateKey(sourceId, recordKey) {
  return {
    source_id: { S: sourceId },
    record_key: { S: recordKey },
  };
}

function alertRecordKey(identifier) {
  return `${alertKeyPrefix}${identifier}`;
}

export function degradedFeatures(records) {
  return records.map(({ feature }) => ({
    ...feature,
    properties: {
      ...feature.properties,
      degraded: true,
    },
  }));
}

export function healthChanged(previousState, status, error = null) {
  return previousState.status !== status
    || (previousState.error ?? null) !== (error ?? null);
}

function featureId(feature) {
  const identifier = feature?.properties?.identifier ?? feature?.id;
  if (identifier === undefined || identifier === null || identifier === "") {
    throw new Error("Cannot persist an alert without an identifier");
  }
  return String(identifier);
}

function isExpired(feature, now) {
  const value = feature?.properties?.expires;
  if (!value) return false;
  const expires = new Date(value);
  return !Number.isNaN(expires.valueOf()) && expires <= now;
}

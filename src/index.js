import { XMLParser } from "fast-xml-parser";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { Buffer } from "node:buffer";
import {
  buildParkOutputs,
  capAreaGeometry,
  loadBoundaries,
  parseCapCircle,
} from "./geometry.js";
import { filterSourceFeatures } from "./filters.js";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { sourceAdapters } from "./adapters/index.js";
import {
  degradedFeatures,
  DynamoAlertStateStore,
  healthChanged,
  reconcileAlertState,
} from "./state.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  processEntities: false,
  isArray: (name) => ["alert", "entry", "item", "info", "area"].includes(name),
});

const dynamo = new DynamoDBClient({});
const s3 = new S3Client({});
const ssm = new SSMClient({});
const canonicalDocumentConcurrency = 10;

export async function handler() {
  const config = await loadRuntimeConfig();
  const output = await pollSources(config, true);
  await publishParkOutputs(output);
  return output;
}

export async function publishParkOutputs(output) {
  if (!process.env.AWS_SAM_OUTPUT_BUCKET) return {};

  const boundaryDirectory = resolve(process.env.BOUNDARIES_DIR ?? "boundaries");
  const boundaries = await loadBoundaries(boundaryDirectory);
  if (!Object.keys(boundaries).length) return {};

  const features = output.sources.flatMap(
    (source) => source.parkCandidates ?? source.alerts,
  );
  const parkOutputs = buildParkOutputs(
    features,
    boundaries,
    output.generatedAt,
    output.sourceConfigs,
    output.sources,
  );
  await Promise.all(
    Object.entries(parkOutputs).map(([parkId, parkOutput]) =>
      s3.send(
        new PutObjectCommand({
          Bucket: process.env.AWS_SAM_OUTPUT_BUCKET,
          Key: `alerts/${parkId}.json`,
          Body: JSON.stringify(parkOutput),
          ContentType: "application/geo+json",
          CacheControl: "max-age=60",
        }),
      ),
    ),
  );
  return parkOutputs;
}

export async function pollSources(config, persistState = true, options = {}) {
  const { sources } = await fetchFeedSources(config);
  const results = [];
  const totalFetchStartedAt = performance.now();
  const stateStore = options.stateStore ?? (persistState
    ? new DynamoAlertStateStore(dynamo, process.env.AWS_SAM_FEED_STATE_TABLE)
    : null);

  for (const source of sources) {
    const ingestion = {
      feedFormat: source.feedFormat,
      feedUrl: source.feedUrl,
      canonicalLinkCount: 0,
      documentCount: 0,
    };
    const fetchStartedAt = performance.now();
    try {
      const alerts = await ingestSource(source, ingestion);
      ingestion.fetchDurationMs = Math.round(performance.now() - fetchStartedAt);
      const lifecycle = reduceAlertLifecycleState(alerts);
      let parkCandidates = lifecycle.features;
      let lastSuccess = new Date().toISOString();
      if (stateStore) {
        const previousState = await stateStore.load(source.id);
        const reconciliation = reconcileAlertState(
          previousState.records,
          parkCandidates,
          { immediatelyRemovedIds: lifecycle.immediatelyRemovedIds },
        );
        await stateStore.saveSuccess(source.id, reconciliation, lastSuccess);
        logHealthChange(source.id, previousState, "ok", null, lastSuccess);
        parkCandidates = reconciliation.features;
      }
      const currentAlerts = filterSourceFeatures(parkCandidates, source);
      const result = {
        id: source.id,
        status: "ok",
        lastSuccess,
        alerts: currentAlerts,
        ingestion,
        filters: filterDiagnostics(source),
      };
      Object.defineProperty(result, "parkCandidates", {
        value: parkCandidates,
      });
      if (options.includeIngestedAlerts) result.ingestedAlerts = alerts;
      results.push(result);
    } catch (error) {
      ingestion.fetchDurationMs = Math.round(performance.now() - fetchStartedAt);
      let parkCandidates = [];
      let lastSuccess = null;
      if (stateStore) {
        const previousState = await stateStore.load(source.id);
        parkCandidates = degradedFeatures(previousState.records);
        lastSuccess = previousState.lastSuccess;
        const failedAt = new Date().toISOString();
        await stateStore.saveFailure(
          source.id,
          error.message,
          failedAt,
          previousState,
        );
        logHealthChange(
          source.id,
          previousState,
          "degraded",
          error.message,
          failedAt,
        );
      }
      const result = {
        id: source.id,
        status: "degraded",
        lastSuccess,
        alerts: filterSourceFeatures(parkCandidates, source),
        ingestion,
        filters: filterDiagnostics(source),
        error: error.message,
      };
      Object.defineProperty(result, "parkCandidates", {
        value: parkCandidates,
      });
      results.push(result);
    }
  }

  const output = {
    sources: results,
    generatedAt: new Date().toISOString(),
    totalFetchDurationMs: Math.round(performance.now() - totalFetchStartedAt),
  };
  Object.defineProperty(output, "sourceConfigs", {
    value: new Map(sources.map((source) => [source.id, source])),
  });
  return output;
}

function filterDiagnostics(source) {
  return {
    minSeverity: source.minSeverity ?? "Unknown",
    minCertainty: source.minCertainty ?? "Unknown",
    minUrgency: source.minUrgency ?? "Unknown",
    categoryAllowlist: source.categoryAllowlist ?? [],
    msgtypeDenylist: source.msgtypeDenylist ?? [],
    agencyAllowlist: source.agencyAllowlist ?? [],
    agencyDenylist: source.agencyDenylist ?? [],
    requireGeometry: source.requireGeometry ?? false,
    overrides: (source.parkOverrides ?? []).map((override, index) => ({
      id: `override_${index + 1}`,
      park: override.parkId ?? override.gatsby_endpoint,
      minSeverity: override.minSeverity ?? override.min_severity ?? "",
      minCertainty: override.minCertainty ?? override.min_certainty ?? "",
      minUrgency: override.minUrgency ?? override.min_urgency ?? "",
      categoryAllowlist: override.categoryAllowlist ?? override.category_allowlist ?? "",
      msgtypeDenylist: override.msgtypeDenylist ?? override.msgtype_denylist ?? "",
      agencyAllowlist: override.agencyAllowlist ?? override.agency_allowlist ?? "",
      agencyDenylist: override.agencyDenylist ?? override.agency_denylist ?? "",
      requireGeometry: override.requireGeometry ?? "",
    })),
  };
}

function logHealthChange(sourceId, previousState, status, error, timestamp) {
  if (!healthChanged(previousState, status, error)) return;
  console.log(JSON.stringify({
    event: "feed-source-health-changed",
    sourceId,
    status,
    error,
    timestamp,
  }));
}

export async function loadRuntimeConfig() {
  return {
    feedSourcesUrl: process.env.DRUPAL_FEED_SOURCES_URL,
    aggregatorSecret: await resolveParameter(
      process.env.AWS_SAM_DRUPAL_AGGREGATOR_SECRET_SSM_PARAMETER,
    ),
  };
}

export function loadLocalConfig(env = process.env) {
  const required = ["DRUPAL_FEED_SOURCES_URL", "DRUPAL_AGGREGATOR_SECRET"];
  for (const name of required) {
    if (!env[name])
      throw new Error(`Missing ${name}; copy .env.example to .env and set it.`);
  }
  return {
    feedSourcesUrl: env.DRUPAL_FEED_SOURCES_URL,
    aggregatorSecret: env.DRUPAL_AGGREGATOR_SECRET,
  };
}

async function resolveParameter(name) {
  const result = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  return result.Parameter?.Value ?? "";
}

export async function fetchFeedSources(config) {
  const response = await fetch(config.feedSourcesUrl, {
    headers: {
      "X-Cap-Aggregator-Secret": config.aggregatorSecret,
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Drupal Feed Source request failed: HTTP ${response.status}`,
    );
  }
  return await response.json();
}

export async function ingestSource(source, ingestion = null) {
  if (source.feedFormat === "rss" || source.feedFormat === "atom") {
    const feed = await fetchText(withDefaultLimit(source.feedUrl), source, ingestion);
    const inlineAlerts = extractInlineCapAlerts(feed, source);
    if (ingestion) ingestion.entryCount = countFeedEntries(feed, source.feedFormat);
    if (inlineAlerts.length) {
      if (ingestion) ingestion.documentCount = inlineAlerts.length;
      return inlineAlerts;
    }
    const links = extractCanonicalLinks(feed, source.feedFormat);
    if (ingestion) ingestion.canonicalLinkCount = links.length;
    if (!links.length && ingestion?.entryCount) {
      throw new Error(
        `Feed contained ${ingestion.entryCount} entries but no inline CAP alerts or canonical links`,
      );
    }
    return await ingestCanonicalDocuments(links, source, ingestion);
  }

  if (source.feedFormat === "cap-xml") {
    const alerts = normalizeCapXml(
      await fetchText(withDefaultLimit(source.feedUrl), source, ingestion),
      source,
    );
    if (ingestion) ingestion.documentCount = 1;
    return alerts;
  }

  const adapter = sourceAdapters.get(source.feedFormat);
  if (adapter) {
    return await adapter(source, ingestion, { fetchJson });
  }

  throw new Error(`Unsupported first-slice feed format: ${source.feedFormat}`);
}

async function ingestCanonicalDocuments(links, source, ingestion) {
  const documents = [];
  const failures = [];
  let nextLinkIndex = 0;

  async function worker() {
    while (nextLinkIndex < links.length) {
      const link = links[nextLinkIndex++];
      try {
        const document = await fetchText(link, source, ingestion);
        documents.push(...normalizeCapXml(document, { ...source, canonicalUrl: link }));
      } catch (error) {
        failures.push({ url: link, error: error.message });
      }
    }
  }

  const workerCount = Math.min(canonicalDocumentConcurrency, links.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (ingestion) {
    ingestion.documentCount = links.length - failures.length;
    ingestion.failedDocumentCount = failures.length;
    if (failures.length) ingestion.documentErrors = failures.slice(0, 10);
  }

  if (failures.length) {
    const firstFailure = failures[0];
    throw new Error(
      `Failed to ingest ${failures.length} of ${links.length} canonical documents; ` +
        `${firstFailure.url}: ${firstFailure.error}`,
    );
  }

  return documents;
}

async function fetchText(url, source, ingestion = null) {
  const response = await fetchSource(url, source);
  if (!response.ok) {
    throw new Error(`Feed request failed: HTTP ${response.status} ${url}`);
  }
  const sourceText = await response.text();
  if (ingestion) {
    ingestion.fetches ??= [];
    ingestion.fetches.push({
      url,
      bytes: Buffer.byteLength(sourceText, "utf8"),
    });
  }
  return sourceText;
}

async function fetchJson(url, source, ingestion = null) {
  const response = await fetchSource(url, source);
  if (!response.ok) {
    throw new Error(`Feed request failed: HTTP ${response.status} ${url}`);
  }
  const sourceText = await response.text();
  if (ingestion) {
    ingestion.fetches ??= [];
    ingestion.fetches.push({
      url: String(url),
      bytes: Buffer.byteLength(sourceText, "utf8"),
    });
  }
  try {
    return { body: JSON.parse(sourceText), headers: response.headers };
  } catch {
    throw new Error(`Feed response was not valid JSON: ${url}`);
  }
}

function fetchSource(url, source) {
  const headers = source.credential
    ? { authorization: `Bearer ${source.credential}` }
    : undefined;
  return fetch(String(url), { headers });
}


export function extractCanonicalLinks(xml, format) {
  const parsed = xmlParser.parse(xml);

  if (format === "rss") {
    const items = asArray(parsed.rss?.channel?.item);
    const links = items.map((item) => item.link).filter(Boolean);
    return links;
  }

  const entries = asArray(parsed.feed?.entry);
  return entries
    .map((entry) => {
      const links = asArray(entry.link);
      return links.find(
        (link) => !link["@_rel"] || link["@_rel"] === "alternate",
      )?.["@_href"];
    })
    .filter(Boolean);
}

// Feeds that support it return more per request; unsupported feeds ignore the parameter.
const defaultFeedItemLimit = 500;

export function withDefaultLimit(feedUrl) {
  try {
    const url = new URL(feedUrl);
    if (!url.searchParams.has("limit")) {
      url.searchParams.set("limit", String(defaultFeedItemLimit));
    }
    return String(url);
  } catch {
    return feedUrl;
  }
}

export function extractInlineCapAlerts(xml, source) {
  const parsed = xmlParser.parse(xml);
  const alerts = [];
  for (const entry of asArray(parsed.feed?.entry)) {
    for (const alert of asArray(entry?.content?.alert)) {
      alerts.push(normalizeAlert(alert, { ...source, canonicalUrl: entry.id }));
    }
  }
  return alerts;
}

export function countFeedEntries(xml, format) {
  const parsed = xmlParser.parse(xml);
  return format === "rss"
    ? asArray(parsed.rss?.channel?.item).length
    : asArray(parsed.feed?.entry).length;
}

export function normalizeCapXml(xml, source) {
  const parsed = xmlParser.parse(xml);
  const root = parsed.alert ? parsed : parsed[source.capXmlRootElement];
  const alerts = asArray(root?.alert ?? root);
  if (!alerts.length) {
    throw new Error("CAP XML document contains no consumable alert elements");
  }

  return alerts.map((alert) => normalizeAlert(alert, source));
}

export function reduceAlertLifecycle(features, now = new Date()) {
  return reduceAlertLifecycleState(features, now).features;
}

export function reduceAlertLifecycleState(features, now = new Date()) {
  const active = new Map();
  const cancelled = new Set();
  const superseded = new Set();
  const expired = new Set();

  for (const feature of features) {
    const properties = feature.properties ?? {};
    const references = parseReferences(properties.references);

    if (properties.retracted) {
      cancelled.add(properties.identifier ?? feature.id);
      continue;
    }

    if (properties.msgType === "Cancel") {
      references.forEach((identifier) => cancelled.add(identifier));
      continue;
    }

    if (properties.msgType === "Update") {
      references.forEach((identifier) => superseded.add(identifier));
    }

    const identifier = properties.identifier ?? feature.id;
    if (isExpired(properties.expires, now)) expired.add(identifier);
    else active.set(identifier, feature);
  }

  const immediatelyRemovedIds = new Set([
    ...cancelled,
    ...superseded,
    ...expired,
  ]);
  const current = [...active.entries()]
    .filter(
      ([identifier]) =>
        !cancelled.has(identifier) && !superseded.has(identifier),
    )
    .map(([, feature]) => feature);
  return { features: current, immediatelyRemovedIds: [...immediatelyRemovedIds] };
}

export function parseReferences(value) {
  if (!value) return [];
  return String(value)
    .trim()
    .split(/\s+/u)
    .map((reference) => reference.split(",")[1] ?? reference)
    .filter(Boolean);
}

export function isExpired(value, now = new Date()) {
  if (!value) return false;
  const expires = new Date(value);
  return !Number.isNaN(expires.valueOf()) && expires <= now;
}

function normalizeAlert(alert, source) {
  const info = asArray(alert.info)[0] ?? {};
  const areas = asArray(info.area);
  const geometries = areas.flatMap((area) =>
    capAreaGeometry(area),
  );
  return {
    type: "Feature",
    id: alert.identifier,
    geometry:
      geometries.length === 1
        ? geometries[0].geometry
        : geometries.length > 1
          ? {
              type: "GeometryCollection",
              geometries: geometries.map((item) => item.geometry),
            }
          : null,
    properties: {
      source: { feedSourceId: source.id },
      sourceType: source.feedFormat,
      degraded: false,
      identifier: alert.identifier,
      sender: alert.sender,
      senderName: info.senderName,
      status: alert.status,
      msgType: alert.msgType,
      references: alert.references,
      sent: alert.sent,
      event: info.event,
      category: asArray(info.category),
      headline: info.headline,
      description: info.description,
      instruction: info.instruction,
      severity: info.severity,
      certainty: info.certainty,
      urgency: info.urgency,
      effective: info.effective,
      expires: info.expires,
      areaDesc: areas.map((area) => area.areaDesc).filter(Boolean),
      circles: areas.flatMap((area) =>
        asArray(area.circle)
          .map(parseCircleMetadata)
          .filter(Boolean),
      ),
      locationIds: parameterValues(info, "ParksAustraliaLocationUUID"),
      parkIds: parameterValues(info, "ParksAustraliaParkId"),
      link: info.web ?? source.canonicalUrl ?? source.feedUrl,
    },
  };
}

function parseCircleMetadata(value) {
  const parsed = parseCapCircle(value);
  if (!parsed) return null;
  const { latitude, longitude, radiusKm } = parsed;
  return { center: [longitude, latitude], radiusKm };
}

function parameterValues(info, valueName) {
  return asArray(info.parameter)
    .filter((parameter) => parameter?.valueName === valueName)
    .flatMap((parameter) => String(parameter.value ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

import { XMLParser } from 'fast-xml-parser';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  processEntities: false,
  isArray: (name) => ['alert', 'entry', 'item', 'info'].includes(name),
});

const dynamo = new DynamoDBClient({});
const ssm = new SSMClient({});

export async function handler() {
  const config = await loadRuntimeConfig();
  return pollSources(config, true);
}

export async function pollSources(config, persistState = true) {
  const { sources } = await fetchFeedSources(config);
  const results = [];

  for (const source of sources) {
    try {
      const alerts = await ingestSource(source);
      if (persistState) await persistSourceState(source, 'ok', alerts.length);
      results.push({ id: source.id, status: 'ok', alerts });
    } catch (error) {
      if (persistState) await persistSourceState(source, 'degraded', 0, error.message);
      results.push({ id: source.id, status: 'degraded', alerts: [] });
    }
  }

  return { sources: results, generatedAt: new Date().toISOString() };
}

export async function loadRuntimeConfig() {
  return {
    feedSourcesUrl: process.env.DRUPAL_FEED_SOURCES_URL,
    apiKey: await resolveParameter(process.env.DRUPAL_API_KEY_PARAMETER),
    aggregatorSecret: await resolveParameter(process.env.DRUPAL_AGGREGATOR_SECRET_PARAMETER),
  };
}

export function loadLocalConfig(env = process.env) {
  const required = ['DRUPAL_FEED_SOURCES_URL', 'DRUPAL_API_KEY', 'DRUPAL_AGGREGATOR_SECRET'];
  for (const name of required) {
    if (!env[name]) throw new Error(`Missing ${name}; copy .env.example to .env and set it.`);
  }
  return {
    feedSourcesUrl: env.DRUPAL_FEED_SOURCES_URL,
    apiKey: env.DRUPAL_API_KEY,
    aggregatorSecret: env.DRUPAL_AGGREGATOR_SECRET,
  };
}

async function resolveParameter(name) {
  const result = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  return result.Parameter?.Value ?? '';
}

export async function fetchFeedSources(config) {
  const response = await fetch(config.feedSourcesUrl, {
    headers: {
      'api-key': config.apiKey,
      'X-Cap-Aggregator-Secret': config.aggregatorSecret,
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Drupal Feed Source request failed: HTTP ${response.status}`);
  }
  return response.json();
}

export async function ingestSource(source) {
  if (source.feedFormat === 'rss' || source.feedFormat === 'atom') {
    const feed = await fetchText(source.feedUrl);
    const links = extractCanonicalLinks(feed, source.feedFormat);
    return Promise.all(
      links.map(async (link) => normalizeCapXml(await fetchText(link), source)),
    );
  }

  if (source.feedFormat === 'cap-xml') {
    return normalizeCapXml(await fetchText(source.feedUrl), source);
  }

  throw new Error(`Unsupported first-slice feed format: ${source.feedFormat}`);
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Feed request failed: HTTP ${response.status} ${url}`);
  }
  return response.text();
}

export function extractCanonicalLinks(xml, format) {
  const parsed = xmlParser.parse(xml);
  if (format === 'rss') {
    const items = asArray(parsed.rss?.channel?.item);
    return items.map((item) => item.link).filter(Boolean);
  }

  const entries = asArray(parsed.feed?.entry);
  return entries
    .map((entry) => {
      const links = asArray(entry.link);
      return links.find((link) => !link['@_rel'] || link['@_rel'] === 'alternate')?.['@_href'];
    })
    .filter(Boolean);
}

export function normalizeCapXml(xml, source) {
  const parsed = xmlParser.parse(xml);
  const root = parsed.alert ? parsed : parsed[source.capXmlRootElement];
  const alerts = asArray(root?.alert ?? root);
  if (!alerts.length) {
    throw new Error('CAP XML document contains no alert elements');
  }

  return alerts.map((alert) => normalizeAlert(alert, source));
}

function normalizeAlert(alert, source) {
  const info = asArray(alert.info)[0] ?? {};
  return {
    type: 'Feature',
    id: alert.identifier,
    geometry: null,
    properties: {
      source: { feedSourceId: source.id },
      identifier: alert.identifier,
      sender: alert.sender,
      status: alert.status,
      msgType: alert.msgType,
      sent: alert.sent,
      event: info.event,
      headline: info.headline,
      description: info.description,
      severity: info.severity,
      certainty: info.certainty,
      urgency: info.urgency,
      effective: info.effective,
      expires: info.expires,
      link: source.feedUrl,
    },
  };
}

async function persistSourceState(source, status, alertCount, error) {
  const item = {
    state_key: { S: `source:${source.id}` },
    status: { S: status },
    alert_count: { N: String(alertCount) },
    updated_at: { S: new Date().toISOString() },
  };
  if (error) item.error = { S: error.slice(0, 1000) };
  await dynamo.send(
    new PutItemCommand({ TableName: process.env.FEED_STATE_TABLE, Item: item }),
  );
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

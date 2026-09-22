import { describe, expect, it, vi } from 'vitest';
import {
  extractCanonicalLinks,
  normalizeCapXml,
  pollSources,
  reduceAlertLifecycle,
} from '../src/index.js';

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

describe('CAP ingestion first slice', () => {
  it('extracts RSS canonical links', () => {
    const rss = '<rss><channel><item><link>https://example.test/a.xml</link></item></channel></rss>';
    expect(extractCanonicalLinks(rss, 'rss')).toEqual(['https://example.test/a.xml']);
  });

  it('extracts Atom canonical links', () => {
    const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="https://example.test/a.xml" /></entry></feed>';
    expect(extractCanonicalLinks(atom, 'atom')).toEqual(['https://example.test/a.xml']);
  });

  it('normalizes a CAP alert and keeps geometry for the next stage', () => {
    const [alert] = normalizeCapXml(capXml, { id: 'drupal', feedUrl: 'https://example.test' });
    expect(alert.id).toBe('sender-1');
    expect(alert.properties.severity).toBe('Severe');
    expect(alert.properties.source.feedSourceId).toBe('drupal');
    expect(alert.geometry).toBeNull();
  });

  it('removes expired alerts', () => {
    const [alert] = normalizeCapXml(capXml, { id: 'source', feedUrl: 'https://example.test' });
    expect(reduceAlertLifecycle([alert], new Date('2026-09-21T03:00:00Z'))).toEqual([]);
  });

  it('removes an alert referenced by a CAP Cancel message', () => {
    const [alert] = normalizeCapXml(capXml, { id: 'source', feedUrl: 'https://example.test' });
    const cancel = {
      id: 'sender-cancel',
      properties: {
        identifier: 'sender-cancel',
        msgType: 'Cancel',
        references: 'sender@example.test,sender-1,2026-09-21T00:00:00-00:00',
      },
    };
    expect(reduceAlertLifecycle([alert, cancel], new Date('2026-09-21T01:00:00Z'))).toEqual([]);
  });

  it('keeps an Update and removes the referenced alert', () => {
    const [alert] = normalizeCapXml(capXml, { id: 'source', feedUrl: 'https://example.test' });
    const update = {
      id: 'sender-update',
      properties: {
        identifier: 'sender-update',
        msgType: 'Update',
        references: 'sender@example.test,sender-1,2026-09-21T00:00:00-00:00',
        expires: '2026-09-21T04:00:00Z',
      },
    };
    expect(reduceAlertLifecycle([alert, update], new Date('2026-09-21T01:00:00Z'))).toEqual([
      update,
    ]);
  });

  it('exposes ingested alerts and source errors for local inspection', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === 'https://drupal.test/sources') {
        return {
          ok: true,
          json: async () => ({
            sources: [
              { id: 'cap', feedFormat: 'cap-xml', feedUrl: 'https://feed.test/cap.xml' },
              { id: 'unsupported', feedFormat: 'geojson', feedUrl: 'https://feed.test/data' },
            ],
          }),
        };
      }
      return { ok: true, text: async () => capXml };
    });
    vi.stubGlobal('fetch', fetchMock);

    const output = await pollSources(
      { feedSourcesUrl: 'https://drupal.test/sources', aggregatorSecret: 'secret' },
      false,
      { includeIngestedAlerts: true },
    );

    expect(output.sources[0].ingestedAlerts).toHaveLength(1);
    expect(output.sources[0].alerts).toHaveLength(0);
    expect(output.sources[0].ingestion.documentCount).toBe(1);
    expect(output.sources[1].status).toBe('degraded');
    expect(output.sources[1].error).toMatch(/Unsupported/);
    vi.unstubAllGlobals();
  });
});

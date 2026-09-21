import { describe, expect, it } from 'vitest';
import { extractCanonicalLinks, normalizeCapXml } from '../src/index.js';

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
});

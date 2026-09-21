import { describe, expect, it } from 'vitest';
import {
  assignFeaturesToParks,
  buildParkOutputs,
  capAreaGeometry,
  parseCapCircle,
  parseCapPolygon,
} from '../src/geometry.js';
import { polygon } from '@turf/helpers';

describe('CAP geometry normalization', () => {
  it('parses CAP polygon coordinates into GeoJSON longitude/latitude order', () => {
    expect(parseCapPolygon('-35.2,149.0 -35.2,149.1 -35.3,149.1')).toEqual([
      [149, -35.2],
      [149.1, -35.2],
      [149.1, -35.3],
      [149, -35.2],
    ]);
  });

  it('parses CAP circles', () => {
    expect(parseCapCircle('-35.2,149.0 5')).toEqual({
      latitude: -35.2,
      longitude: 149,
      radiusKm: 5,
    });
  });

  it('converts polygon and circle areas to geometry features', () => {
    const geometries = capAreaGeometry({
      polygon: '-35.2,149.0 -35.2,149.1 -35.3,149.1',
      circle: '-35.2,149.0 5',
    });
    expect(geometries).toHaveLength(2);
    expect(geometries[0].geometry.type).toBe('Polygon');
    expect(geometries[1].geometry.type).toBe('Polygon');
  });

  it('duplicates an intersecting alert into every matching park', () => {
    const alert = polygon([[
      [149, -35.2],
      [149.1, -35.2],
      [149.1, -35.3],
      [149, -35.3],
      [149, -35.2],
    ]], { identifier: 'alert-1' });
    const boundaries = {
      parkA: polygon([[
        [148.9, -35.1],
        [149.05, -35.1],
        [149.05, -35.35],
        [148.9, -35.35],
        [148.9, -35.1],
      ]]),
      parkB: polygon([[
        [149.05, -35.1],
        [149.2, -35.1],
        [149.2, -35.35],
        [149.05, -35.35],
        [149.05, -35.1],
      ]]),
    };
    const assigned = assignFeaturesToParks([alert], boundaries);
    expect(assigned.parkA).toHaveLength(1);
    expect(assigned.parkB).toHaveLength(1);
  });

  it('builds a per-park FeatureCollection output', () => {
    const alert = polygon([[
      [149, -35.2],
      [149.1, -35.2],
      [149.1, -35.3],
      [149, -35.3],
      [149, -35.2],
    ]], { identifier: 'alert-1' });
    const outputs = buildParkOutputs([alert], { parkA: polygon([[
      [148.9, -35.1],
      [149.2, -35.1],
      [149.2, -35.4],
      [148.9, -35.4],
      [148.9, -35.1],
    ]]) }, '2026-09-21T00:00:00.000Z');
    expect(outputs.parkA).toMatchObject({
      type: 'FeatureCollection',
      schemaVersion: 1,
      park: 'parkA',
      generatedAt: '2026-09-21T00:00:00.000Z',
    });
    expect(outputs.parkA.features).toHaveLength(1);
  });
});

import booleanIntersects from '@turf/boolean-intersects';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import circle from '@turf/circle';
import { point, polygon } from '@turf/helpers';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const EARTH_RADIUS_KM = 6371;

/**
 * Converts CAP area values into GeoJSON features.
 *
 * CAP polygons use `lat,lon lat,lon` pairs. CAP circles use
 * `lat,lon radius-km`. GeoJSON coordinates are always `[longitude, latitude]`.
 */
export function capAreaGeometry(area) {
  const geometries = [];

  for (const value of asArray(area?.polygon)) {
    const coordinates = parseCapPolygon(value);
    if (coordinates) geometries.push(polygon([coordinates]));
  }

  for (const value of asArray(area?.circle)) {
    const parsed = parseCapCircle(value);
    if (parsed) {
      const center = point([parsed.longitude, parsed.latitude]);
      geometries.push(parsed.radiusKm === 0
        ? center
        : circle(center, parsed.radiusKm, { steps: 64, units: 'kilometers' }));
    }
  }

  return geometries;
}

export function parseCapPolygon(value) {
  if (!value) return null;
  const coordinates = String(value)
    .trim()
    .split(/\s+/u)
    .map((pair) => {
      const [latitude, longitude] = pair.split(',').map(Number);
      return Number.isFinite(latitude) && Number.isFinite(longitude)
        ? [longitude, latitude]
        : null;
    });

  if (coordinates.some((coordinate) => coordinate === null) || coordinates.length < 3) {
    return null;
  }

  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push([...first]);
  return coordinates;
}

export function parseCapCircle(value) {
  const match = String(value ?? '').trim().match(/^(-?[\d.]+),\s*(-?[\d.]+)\s+([\d.]+)$/u);
  if (!match) return null;

  const [, latitude, longitude, radiusKm] = match.map(Number);
  if (
    ![latitude, longitude, radiusKm].every(Number.isFinite)
    || latitude < -90
    || latitude > 90
    || longitude < -180
    || longitude > 180
    || radiusKm < 0
    || radiusKm > EARTH_RADIUS_KM
  ) return null;
  return { latitude, longitude, radiusKm };
}

/**
 * Returns the park IDs whose boundaries intersect an alert geometry.
 */
export function matchingParks(alertGeometry, boundaries) {
  return Object.entries(boundaries)
    .filter(([, boundary]) => geometryMatchesBoundary(alertGeometry, boundary))
    .map(([parkId]) => parkId);
}

export function geometryMatchesBoundary(alertGeometry, boundary) {
  if (!alertGeometry || !boundary) return false;
  if (boundary.type === 'FeatureCollection') {
    return boundary.features.some((feature) => geometryMatchesBoundary(alertGeometry, feature));
  }
  if (alertGeometry.geometry?.type === 'GeometryCollection') {
    return alertGeometry.geometry.geometries.some((geometry) => (
      geometryMatchesBoundary({ type: 'Feature', properties: {}, geometry }, boundary)
    ));
  }
  if (alertGeometry.geometry.type === 'Point' && boundary.geometry.type === 'Polygon') {
    return booleanPointInPolygon(alertGeometry, boundary);
  }
  return booleanIntersects(alertGeometry, boundary);
}

export function assignFeaturesToParks(features, boundaries) {
  const output = Object.fromEntries(Object.keys(boundaries).map((parkId) => [parkId, []]));

  for (const feature of features) {
    for (const parkId of matchingParks(feature, boundaries)) {
      output[parkId].push(feature);
    }
  }
  return output;
}

export async function loadBoundaries(directory) {
  const boundaries = {};
  let filenames;
  try {
    filenames = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return boundaries;
    throw error;
  }

    // This expects the naming syntax to be "<parkId>-boundary[_<resolution>m].geojson" or "<parkId>_boundary.geojson", e.g. uktnp-boundary_10m.geojson
  for (const filename of filenames) {
    if (extname(filename).toLowerCase() !== '.geojson') continue;
    const parkId = basename(filename, extname(filename))
      .replace(/-boundary(?:_\d+m)?$/u, '')
      .replace(/_boundaries$/u, '');
    const boundary = JSON.parse(await readFile(join(directory, filename), 'utf8'));
    boundaries[parkId] = boundary.type === 'Feature' || boundary.type === 'FeatureCollection'
      ? boundary
      : { type: 'Feature', properties: { parkId }, geometry: boundary };
  }
  return boundaries;
}

export function buildParkOutputs(features, boundaries, generatedAt = new Date().toISOString()) {
  const assigned = assignFeaturesToParks(features, boundaries);
  return Object.fromEntries(
    Object.entries(assigned).map(([parkId, parkFeatures]) => [parkId, {
      type: 'FeatureCollection',
      schemaVersion: 1,
      park: parkId,
      generatedAt,
      features: parkFeatures,
    }]),
  );
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export { EARTH_RADIUS_KM };

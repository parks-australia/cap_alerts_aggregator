import { ingestDataQuollGeoJson } from "./dataquoll.js";

export const sourceAdapters = new Map([
  ["dataquoll-geojson", ingestDataQuollGeoJson],
  ["dataquoll_geojson", ingestDataQuollGeoJson],
]);
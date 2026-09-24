const SEVERITY_ORDER = ["Unknown", "Minor", "Moderate", "Severe", "Extreme"];
const CERTAINTY_ORDER = ["Unknown", "Unlikely", "Possible", "Likely", "Observed"];
const URGENCY_ORDER = ["Unknown", "Past", "Future", "Expected", "Immediate"];

export function filterSourceFeatures(features, source) {
  return features.filter((feature) => matchesFilters(feature, source));
}

export function filterParkFeatures(features, parkId, sourceConfigs) {
  return features.filter((feature) => {
    const source = sourceConfigs.get(feature.properties?.source?.feedSourceId);
    return matchesFilters(feature, mergeParkOverride(source, parkId));
  });
}

function mergeParkOverride(source, parkId) {
  const override = source?.parkOverrides?.find(
    (candidate) => candidate.gatsby_endpoint === parkId,
  );
  if (!override) return source;

  return {
    ...source,
    minSeverity: override.min_severity || source.minSeverity,
    minCertainty: override.min_certainty || source.minCertainty,
    minUrgency: override.min_urgency || source.minUrgency,
    categoryAllowlist: selectOverride(
      override.category_allowlist,
      source.categoryAllowlist,
    ),
    agencyAllowlist: selectOverride(
      override.agency_allowlist,
      source.agencyAllowlist,
    ),
    agencyDenylist: selectOverride(
      override.agency_denylist,
      source.agencyDenylist,
    ),
  };
}

function selectOverride(override, base) {
  const values = normalizeList(override);
  return values.length > 0 ? values : base;
}

function matchesFilters(feature, filters = {}) {
  const properties = feature.properties ?? {};
  if (filters.requireGeometry && !feature.geometry) return false;
  if (!meetsMinimum(properties.severity, filters.minSeverity, SEVERITY_ORDER)) return false;
  if (!meetsMinimum(properties.certainty, filters.minCertainty, CERTAINTY_ORDER)) return false;
  if (!meetsMinimum(properties.urgency, filters.minUrgency, URGENCY_ORDER)) return false;
  if (includesIgnoreCase(filters.msgtypeDenylist, properties.msgType)) return false;
  if (!matchesAllowlist(filters.categoryAllowlist, properties.category)) return false;
  if (!matchesAllowlist(filters.agencyAllowlist, properties.sender)) return false;
  return !includesIgnoreCase(filters.agencyDenylist, properties.sender);
}

function meetsMinimum(value, minimum, order) {
  if (!minimum || minimum === "Unknown") return true;
  return order.indexOf(value) >= order.indexOf(minimum);
}

function matchesAllowlist(allowlist, value) {
  const values = Array.isArray(value) ? value : [value];
  const list = normalizeList(allowlist);
  return list.length === 0 || values.some((item) => includesIgnoreCase(list, item));
}

function includesIgnoreCase(values, value) {
  return normalizeList(values).some(
    (item) => item.toLowerCase() === String(value ?? "").toLowerCase(),
  );
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
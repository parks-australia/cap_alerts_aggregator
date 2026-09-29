# CAP Alerts Aggregator

Standalone Node.js AWS SAM service for polling CAP Feed Sources configured in Drupal and publishing current per-park alert data for Parks Australia websites and future consumers.

- [CAP Alerts Aggregator](#cap-alerts-aggregator)
  - [Drupal Dependency](#drupal-dependency)
  - [Current vertical slice](#current-vertical-slice)
  - [Local development](#local-development)
    - [Local Drupal testing](#local-drupal-testing)
  - [SAM deployment](#sam-deployment)
  - [Viewing DynamoDB state data](#viewing-dynamodb-state-data)
  - [Cloudfront CORS policy](#cloudfront-cors-policy)


## Drupal Dependency

This project requires Drupal to provide Feed Source configuration through the
[`cap_alerts_aggregator_connector`](../cap_alerts_aggregator_connector/) module.
The aggregator retrieves enabled source URLs, filters, optional credentials, and
enabled adaptor data from that module's protected
`/api/cap-alerts/feed-sources` endpoint; it does not manage Feed Sources itself.

## Current vertical slice

- Node.js 22 Lambda invoked by EventBridge every minute.
- DynamoDB state table for source health and future lifecycle state.
- S3 output bucket.
- Secure Drupal Feed Source retrieval using the Drupal connector shared secret stored in SSM for AWS
  and `X-Cap-Aggregator-Secret` locally/in requests.
- RSS and Atom canonical-link extraction.
- CAP XML parsing with external entity processing disabled.
- Normalized GeoJSON Feature-shaped alert objects.
- Provider-specific ingestion adapters registered separately from generic CAP ingestion.
- Optional per-park GeoJSON boundary matching and FeatureCollection output.
- Unit tests using Vitest.

Park attribution, boundary matching, cancellation/expiry reduction, GeoJSON adapters, EDXL-DE, per-park S3 publication, and CloudFront delivery are the next stages. Drupal's current CAP RSS output does not expose Alert `field_site` metadata in the feed response, so the Drupal source adapter must resolve that association before writing per-park output.

## Local development

To spin up a local version:

```sh
git clone <repository-url/cap_alerts_aggregator.git>
cd cap_alerts_aggregator
npm install
npm run local:poll
```

To run tests:

```sh
npm test
npm run lint
```

To deploy to AWS using SAM (check details in `sam.toml` before running!):

```sh
npm run sam:validate
npm run sam:build
npm run sam:deploy
```

### Local Drupal testing

Copy `.env.example` to `.env` in this project directory and set:

- `DRUPAL_FEED_SOURCES_URL`: normally
  `https://parksaustralia-cms.ddev.site/api/cap-alerts/feed-sources/`.
- `DRUPAL_AGGREGATOR_SECRET`: the Key value configured in Drupal's CAP Aggregator Connector settings.
- `LOCAL_OUTPUT_FILE`: optional path for the normalized local output; defaults to
  `.local-output/aggregator.json`.
- `BOUNDARIES_DIR`: directory containing boundary files named by park shortcode. The supplied
  files are under `assets/boundary_data/` and use names such as `anbg-boundary_10m.geojson` and
  `bnp-boundary_10m.geojson`; the `-boundary` and optional resolution suffix are normalized
  automatically.
- `LOCAL_OUTPUT_DIR`: optional directory for per-park files; defaults to `.local-output/parks`.

Variables naming Drupal or AWS are explicitly service-scoped. Local filesystem/output variables stay
short because they are internal to this project. AWS SAM parameters remain CloudFormation parameters;
`DrupalAggregatorSecretSsmParameter` must be the name of an AWS SSM SecureString, not the secret
value itself. The Lambda resolves that parameter with `ssm:GetParameter` at runtime. `AWS_SAM_*`
variables are application environment variables injected by this SAM stack; the prefix is not an
AWS-required naming syntax.

Then run:

```sh
cp .env.example .env
# Edit .env with local values.
npm run local:poll
```

The local runner calls Drupal, fetches the configured RSS/Atom/CAP-XML sources, skips DynamoDB/SSM,
and writes the result to `.local-output/aggregator.json`. That local file includes both
`ingestedAlerts` (normalized before expiry/cancellation reduction) and `alerts` (after lifecycle
reduction and the source's configured filters). The aggregator applies these filters locally after
retrieval; it does not append them as query parameters to the feed URL. Per-park overrides are
applied only when building each park's output, after geographic matching. A populated override field
replaces its source field for that park; a blank override field inherits the source field. A park with
no override, or an override with every field blank, therefore uses the source filters. If
`BOUNDARIES_DIR` contains boundary
files, it also writes one FeatureCollection per park, such as `.local-output/parks/knp.json`.
Only alert features with polygon/circle-derived geometry intersecting a supplied park boundary are
included in that park's file; alerts with no usable geometry are culled from per-park output.
These local files are the current inspection point. S3/CloudFront publication remains a deployment
stage.

Per-park files implement the version-one contract documented by
`schemas/park-alerts-v1.schema.json`. Each file includes source health, attribution, and normalized
alert features. Freshly fetched features have `properties.degraded: false`. When a source poll fails,
its last-known-good features are loaded from DynamoDB and published with `degraded: true`; failed
polls do not count as missing-alert polls. After successful polls, an alert missing once remains in
the output and is removed after the second consecutive absence. Explicit CAP cancellation/update
references, native retractions, and expiry remove persisted alerts immediately.

DynamoDB uses `source_id` as its partition key and `record_key` as its sort key. Each alert is stored
separately to avoid the 400 KB item limit, with one `METADATA` item per source for health and
`lastSuccess`. Deployments created from the earlier single-key `state_key` template must replace or
migrate the state table; changing a DynamoDB primary key cannot be performed in place. Alert records
without a provider expiry receive a rolling seven-day TTL and are refreshed by successful polls.
Source health is logged as structured JSON only on the first result or when status/error changes.

Parks Australia CAP documents carry association metadata through standard CAP `<parameter>`
elements. `ParksAustraliaParkId` contains a Gatsby park shortcode and
`ParksAustraliaLocationUUID` contains a Drupal Location UUID. Both parameters may be repeated.
Geometry is always authoritative when present. For Drupal-authored alerts, selected park IDs limit
the eligible parks and the geometry must also intersect each eligible park boundary. An alert with
geometry outside its selected park is not published for that park or reassigned to another park.
Only a geometry-less alert falls back to its explicit park IDs. External feeds without explicit park
IDs continue through boundary intersection. Per-park overrides change filters after geographic
assignment; they never assign an alert to a park. Exact CAP circles are retained in
`properties.circles` while their GeoJSON polygon approximation remains in `geometry` for spatial
filtering and standard clients.

For source diagnostics, inspect the fetch and parsing stages with:

```sh
jq '.sources[] | {
  id, status, error,
  fetched: (.ingestion.fetches // [] | length),
  canonicalLinks: .ingestion.canonicalLinkCount,
  documents: .ingestion.documentCount,
  ingestedAlerts: ((.ingestedAlerts // []) | length),
  currentAlerts: (.alerts | length)
}' .local-output/aggregator.json
```

`ingestedAlerts` contains normalized alerts before lifecycle reduction. `alerts` contains the
source-filtered alerts remaining after expiry, cancel, and update handling. A degraded source includes `error`;
successful RSS/Atom sources with `canonicalLinks: 0` returned an empty feed, while a nonzero link
count followed by an error usually means the linked documents were not CAP XML.

## SAM deployment

Local changes will only be detected after `sam build` has been run, as CloudFormation relies on the built artifacts.

```sh
sam build && sam deploy --profile 'parks-sam-manager' --region ap-southeast-2
```

Required deployment parameters:

- `DrupalFeedSourcesUrl`
- `DrupalAggregatorSecretSsmParameter`

## Viewing DynamoDB state data

**Note that table metadata in AWS's DynamoDB UI may lag several hours behind the live data inside the table.** 

To get the current count, use the following scan command:

```sh
aws dynamodb scan --table-name <dynamodb-table-name> --select COUNT --profile <aws-profile-name> --region ap-southeast-2
```

## Cloudfront CORS policy

The Cloudfront instance should return a `403` to browser requests, but serves the content publicly via `curl` requests. The CORS policy doesn't prevent untrusted origins from making requests, but it does control which origins are allowed to access the resources from a browser context e.g via JavaScript `fetch` requests.

The permitted origins are defined under 'parameter_overrides' in the `samconfig.toml` configuration file.

To test the Cloudfront CORS policy and see the final output of the aggregator, you can use the following commands:

```sh
export URL="https://your-cloudfront-instance-url/alerts/<filename.ext>"
```

e.g. `https://your-cloudfront-instance-url/alerts/knp.json`

Then try curling it:

```sh
curl -I -H 'Origin: https://seems-legit.trusted' "$URL"
curl -I -H 'Origin: https://untrusted.example' "$URL"
```

Any changes to the Cloudfront CORS policy in the `samconfig.toml` file will require a redeployment using `sam build && sam deploy` for the changes to take effect.
# CAP Alerts Aggregator

Standalone Node.js AWS SAM service for polling CAP Feed Sources configured in Drupal and publishing current per-park alert data for Parks Australia websites and future consumers.

## Current vertical slice

- Node.js 22 Lambda invoked by EventBridge every minute.
- DynamoDB state table for source health and future lifecycle state.
- S3 output bucket.
- Secure Drupal Feed Source retrieval using the Drupal connector shared secret stored in SSM for AWS
  and `X-Cap-Aggregator-Secret` locally/in requests.
- RSS and Atom canonical-link extraction.
- CAP XML parsing with external entity processing disabled.
- Normalized GeoJSON Feature-shaped alert objects.
- Optional per-park GeoJSON boundary matching and FeatureCollection output.
- Unit tests using Vitest.

Park attribution, boundary matching, cancellation/expiry reduction, GeoJSON adapters, EDXL-DE, per-park S3 publication, and CloudFront delivery are the next stages. Drupal's current CAP RSS output does not expose Alert `field_site` metadata in the feed response, so the Drupal source adapter must resolve that association before writing per-park output.

## Local development

```sh
npm install
npm run local:poll
npm test
npm run lint
npm run sam:validate
npm run sam:build
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
and writes the result to `.local-output/aggregator.json`. If `BOUNDARIES_DIR` contains boundary
files, it also writes one FeatureCollection per park, such as `.local-output/parks/knp.json`.
Only alert features with polygon/circle-derived geometry intersecting a supplied park boundary are
included in that park's file; alerts with no usable geometry are culled from per-park output.
These local files are the current inspection point. S3/CloudFront publication remains a deployment
stage.

## SAM deployment

```sh
sam deploy --guided
```

Required deployment parameters:

- `DrupalFeedSourcesUrl`
- `DrupalAggregatorSecretSsmParameter`

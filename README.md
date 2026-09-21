# CAP Alerts Aggregator

Standalone Node.js AWS SAM service for polling CAP Feed Sources configured in Drupal and publishing current per-park alert data for Parks Australia websites and future consumers.

## Current vertical slice

- Node.js 22 Lambda invoked by EventBridge every minute.
- DynamoDB state table for source health and future lifecycle state.
- S3 output bucket.
- Secure Drupal Feed Source retrieval using SSM parameters, `api-key`, and `X-Cap-Aggregator-Secret`.
- RSS and Atom canonical-link extraction.
- CAP XML parsing with external entity processing disabled.
- Normalized GeoJSON Feature-shaped alert objects.
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
- `DRUPAL_API_KEY`: the local Drupal API key accepted by the connector endpoint.
- `DRUPAL_AGGREGATOR_SECRET`: the Key value configured in Drupal's CAP Aggregator Connector settings.
- `LOCAL_OUTPUT_FILE`: optional path for the normalized local output; defaults to
	`.local-output/aggregator.json`.

Then run:

```sh
cp .env.example .env
# Edit .env with local values.
npm run local:poll
```

The local runner calls Drupal, fetches the configured RSS/Atom/CAP-XML sources, skips DynamoDB/SSM,
and writes the result to `.local-output/aggregator.json`. That file is the current local inspection
point. It is not yet the final per-park output; park attribution, lifecycle filtering, and S3/
CloudFront publication are later stages.

## SAM deployment

```sh
sam deploy --guided
```

Required deployment parameters:

- `DrupalFeedSourcesUrl`
- `DrupalApiKeyParameter`
- `DrupalAggregatorSecretParameter`

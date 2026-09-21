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
npm test
npm run lint
npm run sam:validate
npm run sam:build
```

## SAM deployment

```sh
sam deploy --guided
```

Required deployment parameters:

- `DrupalFeedSourcesUrl`
- `DrupalApiKeyParameter`
- `DrupalAggregatorSecretParameter`

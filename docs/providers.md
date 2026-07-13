# Provider configuration

The CLI reads `fal-tools.config.yaml` next to the manifest. This file is a
reviewed capability and pricing registry, not a credential file.

```yaml
version: 1
providers:
  fal:
    models:
      fal-ai/illustration-v0:
        kind: image
        artifactPath: [images, "0", url]
        allowedInputKeys: [width, height]
        pricing:
          perCallUsd: 0
          source: Synthetic documentation fixture
          timestamp: 2026-07-13T00:00:00Z
```

Use the actual model output path and accepted input keys. Prices must come from
a reviewed source, carry its location or identifier, and use that source's
observation timestamp. The repository deliberately contains no fal.ai price
table. Update configuration when provider pricing changes.

A model without `pricing` is unpriced. `plan` displays `UNKNOWN` and stops by
default. Both planning and running require the explicit `--allow-unpriced`
option to proceed. A zero price is valid only for a real zero-cost contract or a
synthetic fixture.

The library API accepts Zod schemas directly:

```ts
const fal = createFalProvider({
  models: {
    "fal-ai/illustration-v0": {
      kind: "image",
      inputSchema,
      artifactPath: ["images", "0", "url"],
      pricing: {
        currency: "USD",
        perCallMicros: 10_000,
        source: "Reviewed provider quote",
        timestamp: "2026-07-13T00:00:00Z",
      },
    },
  },
});
```

The adapter uses `@fal-ai/client` queue subscription, disables provider logs,
extracts only the configured HTTPS artifact URL, downloads bounded bytes, and
discards the URL and response object. It classifies rate limits, selected server
failures, timeouts, and network failures as transient. Authentication,
validation, policy, and malformed-result failures are not retried.

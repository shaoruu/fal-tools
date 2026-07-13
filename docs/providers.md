# Provider integration

`@fal-tools/provider-fal` uses `createFalClient` from the current
`@fal-ai/client`. Generation follows the durable queue path:

1. submit the generic endpoint ID and validated input plus the transient prompt;
2. wait for queue completion without requesting provider logs;
3. retrieve the result;
4. locate the first HTTPS media URL in the returned data;
5. require every download and redirect host to remain under `fal.media`;
6. stream at most 512 MiB and discard the URL and response structure.

Only bytes, media type, and request ID cross the provider boundary. Signed URLs,
response bodies, and headers never enter the logger or run ledger.

## Capability registry

Every model used by a plan must have an explicit capability entry containing:

- supported `image` and/or `audio` kinds;
- supported output formats;
- optional per-call USD pricing with `source` and `retrievedAt`.

The registry is intentionally caller-supplied. This avoids a stale baked-in
price table and lets private deployments attach pricing to their own reviewed
source. Missing pricing remains valid for planning, appears as `UNKNOWN`, and
fails execution unless `isUnpricedCallsAllowed` is explicitly true.

The current v0 price unit is one provider call. A future capability can add
provider-specific units without changing manifest job semantics.

## Errors and retries

Ambiguous queue submission failures are converted to a permanent safe failure
before the SDK can retry them, preventing one reserved attempt from creating
multiple jobs. Other adapter failures are classified as transient only for HTTP
408, 429, 500, 502, 503, and 504 responses and network failures, except
caller-requested timeouts. Core retries only those failures, for at most three
attempts with bounded exponential delay. Every attempt is durably reserved in
the run ledger before submission; it consumes the lifetime hard call ceiling,
and its known price consumes the lifetime hard cost ceiling. Validation,
authentication, unsupported model, malformed output, unsafe download
destination, download-size, and other permanent failures are not retried.

Tests use a fake provider and never contact fal.ai.

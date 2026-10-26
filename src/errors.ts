/** Base class for every error thrown by the SDK. */
export class OlxSdkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** An endpoint has not been mapped yet (see docs/ENDPOINT-CAPTURE.md). */
export class EndpointNotConfiguredError extends OlxSdkError {
  constructor(public readonly endpoint: string) {
    super(
      `OLX endpoint "${endpoint}" is not configured yet. Capture the real request with ` +
        '`npm run capture` and add it to your endpoints file (see docs/ENDPOINT-CAPTURE.md).',
    );
  }
}

/** No saved session, or OLX rejected it (expired login, or bot protection). */
export class AuthError extends OlxSdkError {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

/** OLX answered with a non-2xx status that is not an auth problem. */
export class OlxHttpError extends OlxSdkError {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`OLX returned HTTP ${status} for "${endpoint}"`);
  }
}

/**
 * A write was sent to OLX but its outcome is unknown (network error after sending, 5xx,
 * or a response the adapter couldn't read). The ad may exist, so it must not be blindly re-sent.
 */
export class UncertainWriteError extends OlxSdkError {
  constructor(
    public readonly endpoint: string,
    message: string,
    options?: { cause?: unknown; status?: number; body?: unknown },
  ) {
    super(message, options);
    this.status = options?.status;
    this.body = options?.body;
  }
  readonly status?: number;
  readonly body?: unknown;
}

/** An image could not be uploaded; no ad request was sent, so it is safe to retry. */
export class ImageUploadError extends OlxSdkError {}

/**
 * A product's link to OLX needs a human decision before it can be synced again: an earlier
 * create had an unknown outcome, or the linked ad no longer exists on OLX.
 */
export class ReconcileRequiredError extends OlxSdkError {
  constructor(
    public readonly productId: string,
    public readonly reason: 'uncertain_create' | 'ad_gone',
  ) {
    super(
      reason === 'uncertain_create'
        ? `Product "${productId}": an earlier create may or may not have posted an ad. Check "My ads" on OLX, ` +
            'then resolve it: link the ad id if it exists, or forget the link to allow posting again.'
        : `Product "${productId}": the linked OLX ad no longer exists (deleted or expired on OLX). ` +
            'Forget the link to post a new ad, or link a different ad id.',
    );
  }
}

/** A product could not be translated into an OLX listing (unknown category, missing attribute…). */
export class MappingError extends OlxSdkError {
  constructor(
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/**
 * Stable, machine-readable error codes. They are part of the public API (also over REST
 * and in webhooks): branch on `err.code`, not on class names or messages.
 */
export type OlxErrorCode =
  | 'sdk_error'
  | 'invalid_listing'
  | 'auth_failed'
  | 'olx_rejected'
  | 'outcome_unknown'
  | 'image_upload_failed'
  | 'reconcile_required'
  | 'link_conflict'
  | 'healthy_link'
  | 'endpoint_not_configured';

/** Base class for every error thrown by the SDK. */
export class OlxSdkError extends Error {
  /** Stable code for this kind of failure (see `OlxErrorCode`). */
  readonly code: OlxErrorCode = 'sdk_error';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** An endpoint has not been mapped yet (see docs/ENDPOINT-CAPTURE.md). */
export class EndpointNotConfiguredError extends OlxSdkError {
  override readonly code = 'endpoint_not_configured' as const;

  constructor(public readonly endpoint: string) {
    super(
      `OLX endpoint "${endpoint}" is not configured. Pass it in \`endpoints\` (see docs/ENDPOINT-CAPTURE.md ` +
        'to capture it with `olx-lb capture`).',
    );
  }
}

/** No saved session, or OLX rejected it (expired login, or bot protection). */
export class AuthError extends OlxSdkError {
  override readonly code = 'auth_failed' as const;

  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

/** OLX answered with a non-2xx status that is not an auth problem. */
export class OlxHttpError extends OlxSdkError {
  override readonly code = 'olx_rejected' as const;

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
  override readonly code = 'outcome_unknown' as const;

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

/**
 * `link` would replace a healthy link to a different ad (orphaning that ad), or take an ad
 * that another product is already linked to (two products editing one ad).
 */
export class LinkConflictError extends OlxSdkError {
  override readonly code = 'link_conflict' as const;

  constructor(
    public readonly productId: string,
    public readonly currentAdId: string,
    /** Set when the ad belongs to another product. */
    public readonly otherProductId?: string,
  ) {
    super(
      otherProductId
        ? `Ad ${currentAdId} is already linked to product "${otherProductId}". Pass replace: true to move ` +
            `the link to "${productId}" (product "${otherProductId}" will then have no ad).`
        : `Product "${productId}" is already linked to ad ${currentAdId}. Pass replace: true to re-link it ` +
            '(the current ad will no longer be managed — delete it on OLX if it should not stay live).',
    );
  }
}

/** `forget` on a healthy link would leave that ad live but unmanaged, and the next sync would post another. */
export class ForgetConflictError extends OlxSdkError {
  override readonly code = 'healthy_link' as const;

  constructor(
    public readonly productId: string,
    public readonly currentAdId: string,
  ) {
    super(
      `Product "${productId}" has a healthy link to ad ${currentAdId}. Use DELETE to remove the ad, or pass ` +
        'force: true to forget the link anyway (the ad stays live on OLX, unmanaged).',
    );
  }
}

/** An image could not be uploaded; no ad request was sent, so it is safe to retry. */
export class ImageUploadError extends OlxSdkError {
  override readonly code = 'image_upload_failed' as const;
}

/**
 * A product's link to OLX needs a human decision before it can be synced again: an earlier
 * create had an unknown outcome, or the linked ad no longer exists on OLX.
 */
export class ReconcileRequiredError extends OlxSdkError {
  override readonly code = 'reconcile_required' as const;

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
  override readonly code = 'invalid_listing' as const;

  constructor(
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/** A serialisable description of an error, as the REST service and webhooks report it. */
export interface ErrorInfo {
  /** An `OlxErrorCode`, `internal_error` for unexpected failures, or `cancelled` for a job dropped at shutdown. */
  code: OlxErrorCode | 'internal_error' | 'cancelled';
  message: string;
  /** OLX's HTTP status, when OLX answered. */
  status?: number;
  /** Extra facts for the code: validation issues, OLX's field errors, the conflicting ad… */
  details?: Record<string, unknown>;
}

/** Turns any thrown value into an `ErrorInfo`. Unknown errors become `internal_error`. */
export function toErrorInfo(err: unknown): ErrorInfo {
  if (!(err instanceof OlxSdkError)) {
    return { code: 'internal_error', message: err instanceof Error ? err.message : String(err) };
  }
  const info: ErrorInfo = { code: err.code, message: err.message };
  const details: Record<string, unknown> = {};
  if (err instanceof MappingError) details.issues = err.issues;
  if (err instanceof OlxHttpError) {
    info.status = err.status;
    // OLX's validation answer names the rejected field, e.g. {"location_id": ["…"]}.
    const body = err.body as { message?: unknown; errors?: unknown } | undefined;
    if (body && typeof body === 'object') {
      if (typeof body.message === 'string') details.olxMessage = body.message;
      if (body.errors && typeof body.errors === 'object') details.olxErrors = body.errors;
    }
  }
  if (err instanceof AuthError && err.status) info.status = err.status;
  if (err instanceof UncertainWriteError && err.status) info.status = err.status;
  if (err instanceof ReconcileRequiredError) details.reason = err.reason;
  if (err instanceof LinkConflictError) {
    details.adId = err.currentAdId;
    if (err.otherProductId) details.otherProductId = err.otherProductId;
  }
  if (err instanceof ForgetConflictError) details.adId = err.currentAdId;
  if (Object.keys(details).length) info.details = details;
  return info;
}

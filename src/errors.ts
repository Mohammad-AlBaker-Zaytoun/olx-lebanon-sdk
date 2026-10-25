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

/** A product could not be translated into an OLX listing (unknown category, missing attribute…). */
export class MappingError extends OlxSdkError {
  constructor(
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(message);
  }
}

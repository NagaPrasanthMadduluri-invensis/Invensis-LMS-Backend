export class AppError extends Error {
  /**
   * `details` is an optional machine-readable body merged into the JSON error
   * response. Use it when the client has to *do* something with the refusal —
   * e.g. a 409 that a confirmation dialog can act on — rather than just show
   * the message.
   */
  constructor(message, status = 400, details = null) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.details = details;
  }
}

/**
 * Errors of the Orca transport. Each one says whether retrying can help, so
 * the caller never guesses from a message.
 */

export class OrcaError extends Error {
  readonly code: string;
  /** True only when repeating the same read can succeed. Actions are never retried. */
  readonly retriable: boolean;

  constructor(code: string, message: string, retriable = false) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retriable = retriable;
  }
}

/** The orca executable is missing, or the Orca app is not running or reachable. */
export class OrcaUnavailableError extends OrcaError {
  constructor(message: string, code = "orca_unavailable") {
    super(code, message, code === "runtime_unavailable");
  }
}

/** A command ran past its deadline. Its effect on the page is unknown. */
export class OrcaTimeoutError extends OrcaError {
  constructor(command: string, timeoutMs: number) {
    super("timeout", `orca ${command} did not finish within ${timeoutMs} ms`);
  }
}

/** The caller cancelled the command through its AbortSignal. */
export class OrcaAbortError extends OrcaError {
  constructor(command: string) {
    super("aborted", `orca ${command} was cancelled`);
  }
}

/** The tab is gone: closed by the user, or never existed. */
export class OrcaTabGoneError extends OrcaError {
  constructor(pageId: string) {
    super("tab_gone", `The Orca tab ${pageId} is no longer open`);
  }
}

/** The transport's own rules refused the command before it reached Orca. */
export class OrcaPolicyError extends OrcaError {
  constructor(message: string) {
    super("policy_denied", message);
  }
}

/**
 * The page waits for something only the user may do: a passkey, a security
 * key or another sign-in step. The transport never completes these.
 */
export class OrcaHumanActionRequiredError extends OrcaError {
  constructor(message: string) {
    super("human_action_required", message);
  }
}

/** Orca answered with something that is not the documented JSON envelope. */
export class OrcaProtocolError extends OrcaError {
  constructor(message: string) {
    super("protocol_error", message);
  }
}

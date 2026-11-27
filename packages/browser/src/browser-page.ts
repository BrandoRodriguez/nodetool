/**
 * The page surface the browser actions drive, independent of how the page is
 * reached.
 *
 * `CdpPage` satisfies it for the local and extension transports. A transport
 * registered through `registerBrowserTransport` supplies its own
 * implementation. The members are the ones `actions.ts`, `capture.ts` and
 * `upload.ts` call, and nothing more.
 */

/** A function shipped into the page context, called with JSON-serialisable arguments. */
export type BrowserPageFunction = (...args: never[]) => unknown;

/** When a navigation counts as finished. */
export type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle";

/** One console message the page emitted. */
export interface BrowserPageConsoleMessage {
  type: string;
  text: string;
}

export interface BrowserPage {
  /** The page URL as of the last navigation or action. */
  url(): string;
  viewportSize(): { width: number; height: number };
  title(): Promise<string>;
  on(
    event: "console",
    handler: (msg: BrowserPageConsoleMessage) => void
  ): void;
  goto(
    url: string,
    opts?: { waitUntil?: BrowserWaitUntil; timeout?: number }
  ): Promise<{ status: number | null }>;
  /**
   * Run a function or an expression in the page. Arguments and the result
   * cross as JSON values.
   */
  evaluate<T = unknown>(
    fnOrExpr: string | BrowserPageFunction,
    ...args: unknown[]
  ): Promise<T>;
  click(selector: string): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  press(selector: string, key: string): Promise<void>;
  selectOption(selector: string, value: string): Promise<string[]>;
  setFileInputFiles(selector: string, files: string[]): Promise<void>;
  screenshot(opts?: { fullPage?: boolean }): Promise<Buffer>;
  readonly mouse: {
    move(x: number, y: number): Promise<void>;
    click(x: number, y: number): Promise<void>;
  };
  readonly keyboard: {
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
  };
}

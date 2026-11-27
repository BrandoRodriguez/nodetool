import { BrowserWindow } from "electron";
import { getDesktopBasePort } from "./desktopPort";

export interface ServerState {
  isStarted: boolean;
  status: "idle" | "starting" | "started" | "error";
  bootMsg: string;
  initialURL: string;
  error?: string;
  logs: string[];
  serverPort?: number;
}

let mainWindow: BrowserWindow | null = null;

const initialPort = getDesktopBasePort();

const serverState: ServerState = {
  isStarted: false,
  status: "idle",
  bootMsg: "Initializing...",
  initialURL: `http://127.0.0.1:${initialPort}`,
  error: undefined,
  logs: [],
  serverPort: initialPort,
};

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

export { serverState };

// Type declarations for desktop/src/bridge.mjs. TS maps `./bridge.mjs`
// imports to this `bridge.d.mts` file.
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export const BRIDGE_VERSION: string;
export const DEFAULT_PORT: number;
/** How many consecutive ports the bridge tries on EADDRINUSE (see main.mjs). */
export const BRIDGE_PORT_ATTEMPTS: number;
/** Minimum pairing-token length accepted on both sides (see main.mjs). */
export const TOKEN_MIN_LENGTH: number;
/** Maximum silence between upstream stream chunks before aborting. */
export const STREAM_IDLE_TIMEOUT_MS: number;
/** Overall cap for the non-streaming auth.x.ai passthrough. */
export const OAUTH_UPSTREAM_TIMEOUT_MS: number;

export interface BridgeLog {
  error?: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
}

export interface BridgeServerOptions {
  /** Pairing token required on every non-/health request. */
  token: string;
  /** Upstream fetcher — injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  log?: BridgeLog;
  version?: string;
  /** Override the stream idle watchdog, primarily for tests. */
  streamIdleTimeoutMs?: number;
  /** Override the xai oauth upstream overall timeout, primarily for tests. */
  oauthUpstreamTimeoutMs?: number;
  /**
   * Fallback port for /health when the request socket cannot provide one
   * (direct handleBridgeRequest() calls with a mocked request). Real bridge
   * requests always report the actual bound listen port.
   */
  port?: number;
}

export function handleBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BridgeServerOptions
): Promise<void>;

export function createBridgeServer(options?: BridgeServerOptions): Server;

export interface BridgeListenOptions {
  /** First port to try. Defaults to DEFAULT_PORT. */
  requestedPort?: number;
  /**
   * Last port the walk may try (inclusive). Defaults to the CSP-allowlisted
   * max (DEFAULT_PORT + BRIDGE_PORT_ATTEMPTS - 1).
   */
  maxPort?: number;
  /** Bind host. Defaults to '127.0.0.1'. */
  host?: string;
}

/**
 * Bind `server`, walking consecutive ports on EADDRINUSE. Resolves with the
 * bound port; rejects after the walk is exhausted or on any non-EADDRINUSE
 * listen error (the server is closed on the failure paths).
 */
export function listenBridgeServer(
  server: Server,
  options?: BridgeListenOptions
): Promise<number>;

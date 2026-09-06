// The extension's end of the native messaging port.
//
// This module owns exactly one thing: the connection to `com.openposse.host`. It does not
// know what any message means. Vendor logic lives in `src/vendors/` and receives already-
// dispatched intents — keeping this file free of protocol semantics is what lets it stay
// small enough to audit.

export const HOST_NAME = 'com.openposse.host';

/** Wire protocol version, checked against the app's at handshake. */
export const WIRE_VERSION = '1.0';

/**
 * Chrome caps host→extension messages at 1 MiB and closes the port with no recovery when
 * one exceeds it. We never send anything near this, but asserting beats discovering it
 * under a large "summarize this record" response.
 */
export const MAX_OUTBOUND = 1 << 20;

export class Bridge {
  constructor({ onMessage, onDisconnect } = {}) {
    this.port = null;
    this.onMessage = onMessage ?? (() => {});
    this.onDisconnect = onDisconnect ?? (() => {});
  }

  get connected() {
    return this.port !== null;
  }

  /**
   * Opens the port.
   *
   * `connectNative`, never `sendNativeMessage`: the latter spawns a fresh host process per
   * message and discards everything after the first reply. Streaming a partial answer back
   * — which is the entire latency argument for driving a browser rather than calling an API
   * — is impossible with it.
   *
   * Chrome resolves the host manifest on every call, so a manifest written after the browser
   * started is picked up without a restart.
   */
  connect() {
    if (this.port) return this.port;

    this.port = chrome.runtime.connectNative(HOST_NAME);

    this.port.onMessage.addListener((message) => {
      this.onMessage(message);
    });

    this.port.onDisconnect.addListener(() => {
      // `lastError` is the ONLY way to learn why a native port died. Chrome reports a
      // missing manifest, a bad manifest, a host that failed to start, and a host that
      // wrote junk to stdout all through here — and if it is not read, Chrome logs an
      // "Unchecked runtime.lastError" warning instead and the real reason is lost.
      const reason = chrome.runtime.lastError?.message ?? 'port closed';
      this.port = null;
      this.onDisconnect(reason);
    });

    return this.port;
  }

  /** Sends one envelope. Throws rather than silently killing the port on an oversized one. */
  send(envelope) {
    if (!this.port) throw new Error('bridge not connected');

    // Cheap guard, and the failure it prevents is expensive: an oversized message
    // disconnects the port with no recovery and no useful error.
    const size = new TextEncoder().encode(JSON.stringify(envelope)).length;
    if (size > MAX_OUTBOUND) {
      throw new Error(`message of ${size} bytes exceeds the ${MAX_OUTBOUND}-byte limit`);
    }

    this.port.postMessage(envelope);
  }

  disconnect() {
    if (!this.port) return;
    this.port.disconnect();
    this.port = null;
  }
}

/** Builds a protocol envelope. The single place these are constructed. */
export function envelope({ id, type, agent, payload }) {
  return {
    v: WIRE_VERSION,
    id,
    type,
    agent,
    ts: Date.now(),
    payload,
  };
}

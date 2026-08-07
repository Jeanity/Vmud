/**
 * WebSocket transport.
 *
 * Deliberately thin: it decodes messages and dispatches them by tag. It holds no game state, which
 * is the whole point — the server is authoritative and the client is a viewer with opinions.
 *
 * Protocol 23 took the `hello` send out of here: opening the socket no longer names a character,
 * because proving an account and picking a body is a conversation (`login.ts` has it), not a
 * greeting. What this class keeps is the one piece of handshake awareness the queue needs: nothing
 * but `auth` and `enter` may travel before `welcome`, so queued play messages wait for it.
 */

import { decodeServerMessage, encode, type ClientMessage, type ServerMessage } from '@mygame/shared';

type Tag = ServerMessage['t'];
type MessageOf<T extends Tag> = Extract<ServerMessage, { t: T }>;

export type ConnectionState = 'connecting' | 'open' | 'closed';

export class Net {
  private socket: WebSocket | undefined;
  private readonly handlers = new Map<Tag, Set<(m: never) => void>>();
  private readonly queue: ClientMessage[] = [];
  /** True from `welcome` to disconnect: the stretch where play messages mean anything. */
  private entered = false;
  state: ConnectionState = 'connecting';
  onStateChange: ((state: ConnectionState) => void) | undefined;

  constructor(private readonly url: string) {}

  connect(): void {
    this.setState('connecting');
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => this.setState('open'));

    socket.addEventListener('message', (event) => {
      const message = decodeServerMessage(String(event.data));
      if (!message) return;
      if (message.t === 'welcome') {
        // In the world: whatever was typed against a dead socket goes now, in order.
        this.entered = true;
        for (const held of this.queue.splice(0)) socket.send(encode(held));
      }
      const set = this.handlers.get(message.t);
      if (!set) return;
      for (const handler of set) (handler as (m: ServerMessage) => void)(message);
    });

    socket.addEventListener('close', () => {
      this.entered = false;
      this.setState('closed');
      // Reconnect on a fixed delay. Good enough while the server restarts constantly in dev.
      setTimeout(() => this.connect(), 1500);
    });

    socket.addEventListener('error', () => socket.close());
  }

  on<T extends Tag>(tag: T, handler: (message: MessageOf<T>) => void): void {
    let set = this.handlers.get(tag);
    if (!set) {
      set = new Set();
      this.handlers.set(tag, set);
    }
    set.add(handler as (m: never) => void);
  }

  send(message: ClientMessage): void {
    // The handshake's own messages bypass the queue and the `entered` gate — they are what ends it.
    const handshake = message.t === 'auth' || message.t === 'enter';
    if (this.socket && this.socket.readyState === WebSocket.OPEN && (handshake || this.entered)) {
      this.socket.send(encode(message));
      return;
    }
    if (handshake) return; // login.ts reacts to state changes; a stale handshake must not replay
    // Steering intents go stale instantly; queueing them would replay old input on reconnect.
    if (message.t !== 'steer') this.queue.push(message);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }
}

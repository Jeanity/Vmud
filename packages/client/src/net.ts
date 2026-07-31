/**
 * WebSocket transport.
 *
 * Deliberately thin: it decodes messages and dispatches them by tag. It holds no game state, which
 * is the whole point — the server is authoritative and the client is a viewer with opinions.
 */

import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encode,
  type ClientMessage,
  type ServerMessage,
} from '@mygame/shared';

type Tag = ServerMessage['t'];
type MessageOf<T extends Tag> = Extract<ServerMessage, { t: T }>;

export type ConnectionState = 'connecting' | 'open' | 'closed';

export class Net {
  private socket: WebSocket | undefined;
  private readonly handlers = new Map<Tag, Set<(m: never) => void>>();
  private readonly queue: ClientMessage[] = [];
  state: ConnectionState = 'connecting';
  onStateChange: ((state: ConnectionState) => void) | undefined;

  constructor(
    private readonly url: string,
    private readonly playerName: string,
  ) {}

  connect(): void {
    this.setState('connecting');
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.setState('open');
      socket.send(encode({ t: 'hello', protocol: PROTOCOL_VERSION, name: this.playerName }));
      for (const message of this.queue.splice(0)) socket.send(encode(message));
    });

    socket.addEventListener('message', (event) => {
      const message = decodeServerMessage(String(event.data));
      if (!message) return;
      const set = this.handlers.get(message.t);
      if (!set) return;
      for (const handler of set) (handler as (m: ServerMessage) => void)(message);
    });

    socket.addEventListener('close', () => {
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
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(encode(message));
    } else {
      // Steering intents go stale instantly; queueing them would replay old input on reconnect.
      if (message.t !== 'steer') this.queue.push(message);
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }
}

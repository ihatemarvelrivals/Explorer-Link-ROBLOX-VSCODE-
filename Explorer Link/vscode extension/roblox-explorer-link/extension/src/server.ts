/**
 * The link server: a loopback HTTP endpoint the Studio plugin polls.
 *
 * Deliberately free of any `vscode` import so it can be exercised headlessly by
 * test/fake-studio.js — the protocol is the part most worth testing, and it should not
 * need an Extension Host to run.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { AddressInfo } from 'net';

import {
  Command,
  CommandType,
  Hello,
  PluginEvent,
  PROTOCOL_VERSION,
} from './protocol';

export interface SessionInfo extends Hello {
  sessionId: string;
  connectedAt: number;
}

type Waiter = {
  resolve: (commands: Command[]) => void;
  timer: NodeJS.Timeout;
};

type Pending = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type ServerEvents = {
  connected: (session: SessionInfo) => void;
  disconnected: (reason: string) => void;
  event: (event: PluginEvent) => void;
  listening: (port: number) => void;
  error: (error: Error) => void;
};

/**
 * A restart (port change) swaps in a whole new server, so the views hold this box
 * rather than the instance itself — otherwise every provider would need re-wiring.
 */
export interface ServerHandle {
  readonly current: LinkServer;
}

/** How long a command may wait for the plugin before it is treated as lost. */
const COMMAND_TIMEOUT_MS = 15_000;

/** Grace on top of holdMs before a silent plugin is declared gone. */
const LIVENESS_SLACK_MS = 12_000;

export class LinkServer {
  private server: http.Server | undefined;
  private waiters: Waiter[] = [];
  private queue: Command[] = [];
  private pending = new Map<number, Pending>();
  private listeners = new Map<keyof ServerEvents, Set<Function>>();
  private nextCommandId = 1;
  private livenessTimer: NodeJS.Timeout | undefined;
  private lastSeen = 0;

  public session: SessionInfo | undefined;
  public readonly token: string;

  constructor(
    token: string | undefined,
    private port: number,
    private holdMs: number,
  ) {
    // 20 hex chars: short enough to retype by hand into the Studio panel, long enough
    // that another local process is not going to land on it.
    this.token = token ?? crypto.randomBytes(10).toString('hex');
  }

  // -- tiny typed event bus -------------------------------------------------

  on<K extends keyof ServerEvents>(name: K, listener: ServerEvents[K]): void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener);
  }

  private fire<K extends keyof ServerEvents>(name: K, ...args: Parameters<ServerEvents[K]>): void {
    for (const listener of this.listeners.get(name) ?? []) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (error) {
        console.error('[explorer-link] listener threw', error);
      }
    }
  }

  // -- lifecycle ------------------------------------------------------------

  async start(): Promise<number> {
    if (this.server) {
      return this.port;
    }

    const server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        this.reply(response, 500, { error: String(error) });
      });
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        reject(
          error.code === 'EADDRINUSE'
            ? new Error(
                `Port ${this.port} is already in use. Another VS Code window may already be ` +
                  `running Explorer Link — change explorerLink.port if you want two.`,
              )
            : error,
        );
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // Loopback only. Never 0.0.0.0: this endpoint drives a Studio session.
      server.listen(this.port, '127.0.0.1');
    });

    const address = server.address() as AddressInfo;
    this.port = address.port;
    this.fire('listening', this.port);

    this.livenessTimer = setInterval(() => this.checkLiveness(), 4000);
    return this.port;
  }

  async stop(): Promise<void> {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = undefined;
    }
    this.dropSession('server-stopping');
    // Release any held poll so the plugin is not left hanging on a dead socket.
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  get isConnected(): boolean {
    return this.session !== undefined;
  }

  get listeningPort(): number {
    return this.port;
  }

  // -- outbound commands ----------------------------------------------------

  /**
   * Queues a command and resolves with the plugin's result. Rejects if the plugin is
   * absent, disconnects mid-flight, or fails to answer within COMMAND_TIMEOUT_MS.
   */
  send<T>(type: CommandType, payload: Record<string, unknown> = {}): Promise<T> {
    if (!this.session) {
      return Promise.reject(new Error('not-connected'));
    }

    const id = this.nextCommandId++;
    const command: Command = { id, type, ...payload };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${type}`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });

      this.queue.push(command);
      this.wakeOneWaiter();
    });
  }

  private wakeOneWaiter(): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(this.queue.splice(0));
  }

  // -- request handling -----------------------------------------------------

  private reply(response: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
      // A real web origin must never be able to read this, token or not.
      'Access-Control-Allow-Origin': 'null',
      'Cache-Control': 'no-store',
    });
    response.end(text);
  }

  private async readBody(request: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      // A tree page or a script's source can be large; a runaway body cannot.
      if (size > 32 * 1024 * 1024) {
        throw new Error('body too large');
      }
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) {
      return {};
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = request.url ?? '/';

    if (request.method !== 'POST') {
      this.reply(response, 405, { error: 'method-not-allowed' });
      return;
    }

    const token = request.headers['x-rel-token'];
    if (typeof token !== 'string' || !this.tokenMatches(token)) {
      this.reply(response, 401, { error: 'bad-token' });
      return;
    }

    let body: any;
    try {
      body = await this.readBody(request);
    } catch (error) {
      this.reply(response, 400, { error: String(error) });
      return;
    }

    if (url.startsWith('/hello')) {
      this.onHello(body, response);
      return;
    }
    if (url.startsWith('/poll')) {
      await this.onPoll(request, body, response);
      return;
    }
    this.reply(response, 404, { error: 'no-such-endpoint' });
  }

  /** Constant-time compare so the token cannot be probed a character at a time. */
  private tokenMatches(candidate: string): boolean {
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }

  private onHello(body: Hello, response: http.ServerResponse): void {
    if (body?.protocol !== PROTOCOL_VERSION) {
      this.reply(response, 400, {
        error: 'protocol-mismatch',
        protocol: PROTOCOL_VERSION,
      });
      return;
    }

    // A second hello replaces the first: Studio reloaded the plugin, or the place
    // changed. Anything in flight for the old session can never be answered.
    if (this.session) {
      this.dropSession('replaced');
    }

    const session: SessionInfo = {
      ...body,
      sessionId: crypto.randomUUID(),
      connectedAt: Date.now(),
    };
    this.session = session;
    this.lastSeen = Date.now();
    this.queue = [];

    this.reply(response, 200, {
      ok: true,
      sessionId: session.sessionId,
      serverVersion: '1.0.0',
      protocol: PROTOCOL_VERSION,
      holdMs: this.holdMs,
    });

    this.fire('connected', session);
  }

  private async onPoll(
    request: http.IncomingMessage,
    body: { events?: PluginEvent[]; want?: boolean },
    response: http.ServerResponse,
  ): Promise<void> {
    const sessionId = request.headers['x-rel-session'];
    if (!this.session || sessionId !== this.session.sessionId) {
      this.reply(response, 409, { error: 'unknown-session' });
      return;
    }

    this.lastSeen = Date.now();

    for (const event of body?.events ?? []) {
      this.consume(event);
    }

    if (this.queue.length > 0 || !body?.want) {
      this.reply(response, 200, { commands: this.queue.splice(0) });
      return;
    }

    // Hold the connection open. Whichever fires first wins; the other is cleaned up.
    await new Promise<void>((resolve) => {
      const waiter: Waiter = {
        resolve: (commands) => {
          this.reply(response, 200, { commands });
          resolve();
        },
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          this.reply(response, 200, { commands: [] });
          resolve();
        }, this.holdMs),
      };
      this.waiters.push(waiter);

      // If the plugin gives up on the socket, stop holding a response for it.
      request.once('close', () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          resolve();
        }
      });
    });
  }

  private consume(event: PluginEvent): void {
    if (event.type === 'result') {
      const pending = this.pending.get(event.id);
      if (!pending) {
        // Timed out already, or belongs to a previous session. Nothing to do.
        return;
      }
      this.pending.delete(event.id);
      clearTimeout(pending.timer);
      if (event.ok) {
        pending.resolve(event.data);
      } else {
        pending.reject(new Error(event.error ?? 'unknown-error'));
      }
      return;
    }

    if (event.type === 'bye') {
      this.fire('event', event);
      this.dropSession(event.reason);
      return;
    }

    this.fire('event', event);
  }

  private checkLiveness(): void {
    if (!this.session) {
      return;
    }
    if (Date.now() - this.lastSeen > this.holdMs + LIVENESS_SLACK_MS) {
      this.dropSession('timeout');
    }
  }

  private dropSession(reason: string): void {
    if (!this.session) {
      return;
    }
    this.session = undefined;
    this.queue = [];

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`disconnected: ${reason}`));
    }
    this.pending.clear();

    this.fire('disconnected', reason);
  }
}

import type { ClientEvents, ClientState } from "../lib/client";
import type { Ack, Choice, ImageUpload, Project } from "../lib/protocol";
import type { PushSetup } from "../lib/push";

/**
 * What the screens need from a Mac. `RemoteClient` (a paired Mac) has exactly this shape, and so does
 * `DemoSource` (the built-in fixtures behind `?demo`).
 */
export interface Source {
  readonly state: ClientState;
  readonly projects: Project[];
  readonly macName: string;
  on<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void): () => void;
  connect(): void;
  close(): void;
  subscribe(project: string, session: string): void;
  unsubscribe(): void;
  send(project: string, session: string | null, text: string, images?: ImageUpload[]): Promise<Ack>;
  answer(project: string, session: string, requestId: string, choice: Choice): Promise<Ack>;
  interrupt(project: string, session: string): Promise<Ack>;
  open(project: string, session: string): Promise<Ack>;
  openClaude(project: string): Promise<Ack>;
  pushSet(setup: PushSetup): Promise<Ack>;
  pushClear(): Promise<Ack>;
  pushTest(): Promise<Ack>;
  /** Asks the Mac for fresh usage numbers (answered with a `usage` event); nothing while not connected. */
  usageRefresh(): void;
}

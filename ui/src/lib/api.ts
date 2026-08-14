import type {
  ModelContext,
  Plan,
  PlanMode,
  Provider,
  ValidationIssue,
  VerifyReport,
  WireDelta,
  OpProgress,
  CapabilityMiss,
} from '../types';

/**
 * Transport to the local orchestrator.
 *
 * Discovery: the orchestrator writes its port and session token to
 * %LOCALAPPDATA%\DATUM\session.json, and the host (task pane or Studio shell) injects
 * them into the page. Nothing is hard-coded to a port, so several SOLIDWORKS seats can
 * run side by side.
 *
 * When no orchestrator is reachable the client falls into demo mode rather than
 * showing a dead panel — the UI stays inspectable, and every surface is honest about
 * being disconnected.
 */

declare global {
  interface Window {
    DATUM_SESSION?: { port: number; token: string };
  }
}

export interface PlanResponse {
  ok: boolean;
  plan?: Plan;
  issues?: ValidationIssue[];
  error?: string;
  exceededCapability?: boolean;
  partialOps?: number;
  totalOps?: number;
  alternatives?: { id: string; modelId: string; kind: string }[];
}

/** Gesture made in the SOLIDWORKS UI itself — a ribbon button, or right-click "Ask DATUM". */
export interface UiRequest {
  verb: string;
  payload: { mode?: string; useSelection?: boolean } | null;
}

type Listener = {
  deltas: (d: WireDelta[]) => void;
  progress: (p: OpProgress) => void;
  connection: (up: boolean) => void;
  applied: (planId: string, report: VerifyReport) => void;
  uiRequest: (req: UiRequest) => void;
};

class ApiClient {
  private base = '';
  private token = '';
  private socket: WebSocket | null = null;
  private retry = 0;
  private retryTimer: number | null = null;
  private listeners: Partial<Listener> = {};

  /** True when we could not reach an orchestrator and are running on sample data. */
  demo = false;

  get surface(): 'panel' | 'studio' {
    const s = new URLSearchParams(location.search).get('surface');
    return s === 'studio' ? 'studio' : 'panel';
  }

  /**
   * The Studio window is the same bundle on a different surface. The orchestrator serves
   * it, so this points at the orchestrator rather than at the task pane's virtual host —
   * `https://datum.local/` only exists inside the embedded WebView.
   */
  get studioUrl(): string {
    const base = this.base || location.origin;
    const token = this.token ? `&token=${encodeURIComponent(this.token)}` : '';
    return `${base}/index.html?surface=studio${token}`;
  }

  async init(): Promise<void> {
    const session = window.DATUM_SESSION;
    if (session) {
      this.base = `http://127.0.0.1:${session.port}`;
      this.token = session.token;
    } else {
      // Same-origin fallback: the orchestrator also serves this bundle itself.
      this.base = location.origin.startsWith('http') ? location.origin : '';
      this.token = new URLSearchParams(location.search).get('token') ?? '';
    }

    try {
      const res = await fetch(`${this.base}/health`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));

      // A 200 is not proof of an orchestrator. Any static host — including the Vite
      // dev server and a misconfigured reverse proxy — will happily answer /health
      // with an SPA index.html. Require the actual handshake payload, or we would
      // sit there retrying a socket that is never going to exist.
      const body: unknown = await res.json();
      const ok =
        typeof body === 'object' &&
        body !== null &&
        (body as { ok?: unknown }).ok === true &&
        typeof (body as { port?: unknown }).port === 'number';

      if (!ok) throw new Error('not an orchestrator');

      this.demo = false;
      this.openSocket();
    } catch {
      this.demo = true;
      this.listeners.connection?.(false);
    }
  }

  on<K extends keyof Listener>(event: K, fn: Listener[K]): void {
    this.listeners[event] = fn;
  }

  // ── websocket ──────────────────────────────────────────────────────────────

  private openSocket(): void {
    if (this.demo) return;

    const url = `${this.base.replace(/^http/, 'ws')}/ws?surface=${this.surface}&token=${this.token}`;
    try {
      this.socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.retry = 0;
      this.listeners.connection?.(true);
    };

    this.socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; payload: unknown };
        switch (msg.type) {
          case 'deltas':
            this.listeners.deltas?.(msg.payload as WireDelta[]);
            break;
          case 'plan.progress':
            this.listeners.progress?.(msg.payload as OpProgress);
            break;
          case 'plan.applied': {
            const p = msg.payload as { planId: string; report: VerifyReport };
            this.listeners.applied?.(p.planId, p.report);
            break;
          }
          case 'kernel.connected':
            this.listeners.connection?.(true);
            break;
          case 'kernel.disconnected':
            this.listeners.connection?.(false);
            break;
          default:
            // ui.panel.toggle, ui.composer.focus, ui.lint.run — relayed from the add-in.
            if (msg.type.startsWith('ui.')) {
              this.listeners.uiRequest?.({
                verb: msg.type.slice(3),
                payload: (msg.payload ?? null) as UiRequest['payload'],
              });
            }
            break;
        }
      } catch {
        // A malformed frame must not take the panel down.
      }
    };

    this.socket.onclose = () => {
      this.listeners.connection?.(false);
      this.scheduleReconnect();
    };

    this.socket.onerror = () => this.socket?.close();
  }

  /** Exponential backoff, capped — a restarting orchestrator must not be hammered. */
  private scheduleReconnect(): void {
    if (this.retryTimer !== null) return;
    const delay = Math.min(1000 * 2 ** this.retry, 15000);
    this.retry += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.openSocket();
    }, delay);
  }

  // ── http ───────────────────────────────────────────────────────────────────

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }

  getContext(): Promise<ModelContext> {
    return this.call<ModelContext>('/api/context');
  }

  getProviders(): Promise<Provider[]> {
    return this.call<Provider[]>('/api/providers');
  }

  plan(prompt: string, mode: PlanMode, providerId?: string): Promise<PlanResponse> {
    return this.call<PlanResponse>('/api/plan', {
      method: 'POST',
      body: JSON.stringify({ prompt, mode, providerId, attachments: [] }),
    });
  }

  apply(plan: Plan, mode: PlanMode): Promise<{ ok: boolean; report?: VerifyReport; error?: unknown }> {
    return this.call('/api/apply', { method: 'POST', body: JSON.stringify({ plan, mode }) });
  }

  setParam(name: string, value: number, units: string, deferRebuild: boolean) {
    return this.call<{ name: string; value: number; massG: number; errors: number }>('/api/param', {
      method: 'POST',
      body: JSON.stringify({ name, value, units, deferRebuild }),
    });
  }

  /**
   * Preview highlighting. Selects the plan's resolved entities in the real SOLIDWORKS
   * viewport — the affordance that lets a user verify the target without reading JSON.
   * Failures are swallowed: a highlight is a nicety, never worth an error toast.
   */
  highlight(pids: string[]): void {
    if (this.demo) return;
    void this.call('/api/highlight', { method: 'POST', body: JSON.stringify({ pids }) }).catch(
      () => undefined,
    );
  }

  undo(): Promise<{ ok: boolean }> {
    return this.call('/api/undo', { method: 'POST' });
  }

  cancel(): Promise<{ ok: boolean }> {
    return this.call('/api/cancel', { method: 'POST' });
  }
}

export const api = new ApiClient();

export type { CapabilityMiss };

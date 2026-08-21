/**
 * Language model providers.
 *
 * Until now this application used no model at all: `generate/parse.ts` is a deterministic
 * keyword matcher, and that is the *default* rather than a placeholder. It runs offline, it
 * is instant, and it produces the same part for the same words every time — which matters
 * because an engineer who cannot reproduce a result cannot rely on it.
 *
 * A model earns its place on the requests the matcher cannot serve: unusual phrasing, and
 * decomposing something like "a phone" into the components it is made of. So a provider is
 * strictly optional, and when one is configured it does not replace the deterministic path —
 * it feeds the *same* archetype and parameter vocabulary. There is one code path that builds
 * geometry, whatever decided what to build.
 *
 * ── Keys ──
 *
 * Keys are held in this browser's local storage and sent to exactly one place: the provider
 * the key belongs to. Nothing is proxied through a server of ours, because there isn't one —
 * this application has no backend. That also means a key in local storage is readable by
 * anything that can run script on this origin, which is stated plainly in the settings UI
 * rather than buried here.
 */

export type ProviderId = 'none' | 'gemini' | 'anthropic' | 'openai' | 'groq' | 'ollama';

export interface ProviderConfig {
  id: ProviderId;
  /** Model identifier, exactly as the provider names it. */
  model: string;
  apiKey: string;
  /** Base URL, for self-hosted or compatible endpoints. */
  baseUrl?: string;
  /** Let the model search the web, where the provider supports it. */
  allowWebSearch: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Model ids known to exist at the time of writing. The field stays free text. */
  suggestedModels: string[];
  needsKey: boolean;
  keyUrl?: string;
  supportsWebSearch: boolean;
  /**
   * Whether this provider can be sent an image.
   *
   * A property of the *endpoint*, not of the model: every adapter below either has a wire
   * format for image content or it does not. Whether the particular model behind it can see
   * is the user's business, and the provider says so plainly when it cannot.
   */
  supportsImages: boolean;
  note: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'none',
    label: 'None — built-in matcher',
    suggestedModels: [],
    needsKey: false,
    supportsWebSearch: false,
    supportsImages: false,
    note:
      'Offline, instant and repeatable. Handles the shape catalogue and dimensions in plain ' +
      'language. Cannot decompose an unfamiliar object into parts.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    suggestedModels: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite'],
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    supportsWebSearch: true,
    supportsImages: true,
    note:
      'The model id is free text, so any name Google publishes can be used. Supports Google ' +
      'Search grounding, which is the only practical way to look something up from a browser.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    suggestedModels: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
    needsKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    supportsWebSearch: false,
    supportsImages: true,
    note: 'Requires the browser-access header, which Anthropic gates per key.',
  },
  {
    id: 'openai',
    label: 'OpenAI-compatible',
    suggestedModels: ['gpt-4.1-mini', 'gpt-4.1'],
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    supportsWebSearch: false,
    supportsImages: true,
    note: 'Also works with any endpoint that speaks the same chat-completions shape.',
  },
  {
    id: 'groq',
    label: 'Groq',
    // Strongest first, because the first entry is what a new configuration defaults to.
    //
    // This order matters more here than for any other provider. Decomposing an object into
    // thirty correctly-placed parts is a recall-and-reasoning task, and a small model does not
    // fail at it gracefully — it returns a schema-perfect plan describing a box with two
    // cylinders. Defaulting to an 8B model made the whole feature look broken when what was
    // broken was the choice of model, so the 8B entry is last and labelled.
    suggestedModels: [
      'moonshotai/kimi-k2-instruct',
      'openai/gpt-oss-120b',
      'qwen/qwen3-32b',
      'llama-3.3-70b-versatile',
    ],
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    supportsWebSearch: false,
    supportsImages: true,
    note:
      'Runs open models on their own inference hardware, which makes it the fastest of the ' +
      'hosted options by a wide margin — useful when a plan is being generated, inspected and ' +
      'sent back for correction. The API is OpenAI-compatible, so the model id is free text ' +
      'and anything Groq lists will work. Pick the largest model you have access to: ' +
      'decomposing a car into its real parts needs a model that knows what a car is made of, ' +
      'and the small fast ones return a plausible-looking plan with three components in it.',
  },
  {
    id: 'ollama',
    label: 'Local model (Ollama)',
    suggestedModels: ['qwen2.5-coder:14b', 'llama3.1:8b'],
    needsKey: false,
    supportsWebSearch: false,
    supportsImages: true,
    note:
      'Runs on this machine, so nothing leaves it. Start Ollama with ' +
      'OLLAMA_ORIGINS set to allow this page, or the browser will refuse the request.',
  },
];

export const providerInfo = (id: ProviderId): ProviderInfo =>
  PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

// ── storage ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'datum.ai.config.v1';

export function defaultConfig(): ProviderConfig {
  return { id: 'none', model: '', apiKey: '', allowWebSearch: false };
}

export function loadConfig(): ProviderConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig();
    const parsed = JSON.parse(raw) as Partial<ProviderConfig>;
    return { ...defaultConfig(), ...parsed };
  } catch {
    // Private browsing, a full quota, or corrupt data. Falling back to the offline default
    // keeps the application usable rather than failing to start over a settings blob.
    return defaultConfig();
  }
}

export function saveConfig(config: ProviderConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* Nothing useful to do; the session still works, it just will not be remembered. */
  }
}

export function clearKey(): void {
  const c = loadConfig();
  saveConfig({ ...c, apiKey: '' });
}

// ── requests ─────────────────────────────────────────────────────────────────

/**
 * An image attached to a request.
 *
 * Base64 rather than a URL, because there is no server here to host one from and a model's
 * fetcher cannot reach `blob:` or `data:` in a page's own memory. The bytes travel with the
 * request or they do not travel at all.
 */
export interface RequestImage {
  /** As the provider needs it stated: `image/png`, `image/jpeg`, `image/webp`. */
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** The raw base64 payload, with no `data:` prefix — every adapter adds its own framing. */
  base64: string;
  /** What it shows, so a multi-view request can say which view this is. */
  label?: string;
}

export interface CompletionRequest {
  system: string;
  user: string;
  /**
   * Images the model should look at.
   *
   * This interface was text-only, and that was not a gap in a feature — it was a wall in front
   * of a product category. A photograph could reach the classical tracer in `ingest/image/`
   * and nothing else; there was no path by which a model could *see* a part, so multi-view
   * reconstruction, drawing-sheet reading and visual review of what was just built were all
   * unreachable no matter what was built on top.
   *
   * Sending images to a provider that cannot read them is refused rather than silently
   * dropped: a model answering a question about a picture it never received produces a
   * confident description of nothing, which is the worst failure this application has.
   */
  images?: RequestImage[];
  /** Hard ceiling on the reply, so a runaway response cannot hang the UI. */
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  ok: true;
  text: string;
  /** Sources the model cited, when grounding was used. */
  citations: { title: string; uri: string }[];
  provider: ProviderId;
  model: string;
  ms: number;
}

export interface CompletionFailure {
  ok: false;
  /** Something a user can act on, not a status code. */
  message: string;
  /** The provider's own message, kept verbatim for diagnostics. */
  detail?: string;
  retryable: boolean;
}

export type Completion = CompletionResult | CompletionFailure;

const TIMEOUT_MS = 45_000;

/**
 * The largest image any of these APIs will take, as base64 characters.
 *
 * Five megabytes of *encoded* payload, which is about 3.7 MB of image — the lowest common
 * ceiling across Anthropic, OpenAI and Gemini. Checked here rather than left to the provider
 * because a 413 from an image upload reads as a rate limit, and the retry logic below would
 * dutifully shrink the *token budget* in response to a problem no token budget can fix.
 */
const MAX_IMAGE_BASE64 = 5_000_000;

/**
 * Sends one completion request.
 *
 * Every failure path returns a `CompletionFailure` rather than throwing. A model is an
 * optional accessory here: if it is misconfigured, rate limited or simply wrong about a
 * model name, the application must say so and fall back to the deterministic path, not
 * break.
 */
export async function complete(config: ProviderConfig, req: CompletionRequest): Promise<Completion> {
  if (config.id === 'none') {
    return {
      ok: false,
      message: 'No model is configured. Open AI settings to add one.',
      retryable: false,
    };
  }

  const info = providerInfo(config.id);
  if (info.needsKey && !config.apiKey.trim()) {
    return {
      ok: false,
      message: `${info.label} needs an API key. Add one in AI settings.`,
      retryable: false,
    };
  }
  if (!config.model.trim()) {
    return {
      ok: false,
      message: `No model id set for ${info.label}. Try ${info.suggestedModels[0] ?? 'the provider’s current model'}.`,
      retryable: false,
    };
  }

  /*
   * Images to a provider that cannot read them: refused, not dropped.
   *
   * Quietly stripping the attachments and sending the question anyway is the worst available
   * behaviour. The model answers a question about a picture it never received, fluently and in
   * the right format, and the reply is indistinguishable from one grounded in the image — so
   * the failure surfaces as a wrong part rather than as an error.
   */
  if ((req.images ?? []).length > 0 && !info.supportsImages) {
    const seeing = PROVIDERS.filter((candidate) => candidate.supportsImages).map((c) => c.label);
    return {
      ok: false,
      message:
        `${info.label} cannot be sent an image. ` +
        `Choose one that can — ${seeing.join(', ')} — in AI settings.`,
      retryable: false,
    };
  }

  const oversized = (req.images ?? []).find((img) => img.base64.length > MAX_IMAGE_BASE64);
  if (oversized) {
    return {
      ok: false,
      message:
        `${oversized.label ? `The image "${oversized.label}"` : 'An image'} is about ` +
        `${Math.round((oversized.base64.length * 3) / 4 / 1e6)} MB, over the ${
          Math.round((MAX_IMAGE_BASE64 * 3) / 4 / 1e6)} MB every one of these APIs rejects ` +
        `above. Scale it down before sending — detail beyond a couple of megapixels does not ` +
        `survive the model's own resizing anyway.`,
      retryable: false,
    };
  }

  const started = Date.now();

  // Own timeout, combined with any caller cancellation. Without this a provider that
  // accepts the connection and never answers leaves the UI waiting indefinitely.
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), TIMEOUT_MS);
  const signal = req.signal ? anySignal([req.signal, timer.signal]) : timer.signal;

  try {
    switch (config.id) {
      case 'gemini': return await callGemini(config, req, signal, started);
      case 'anthropic': return await callAnthropic(config, req, signal, started);
      // Both speak the same protocol; only the endpoint and the name in an error differ.
      case 'openai': return await callOpenAi(config, req, signal, started, 'openai');
      case 'groq': return await callOpenAi(config, req, signal, started, 'groq');
      case 'ollama': return await callOllama(config, req, signal, started);
      default:
        return { ok: false, message: 'That provider is not supported.', retryable: false };
    }
  } catch (e) {
    return classifyNetworkError(e, providerInfo(config.id));
  } finally {
    clearTimeout(timeout);
  }
}

/** Combines abort signals, since AbortSignal.any is not universally available yet. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) { controller.abort(); break; }
    s.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/**
 * Turns a thrown fetch error into something a user can act on.
 *
 * A bare "Failed to fetch" is the single least useful message in web development: it covers
 * a wrong URL, an offline machine, a blocked origin and a browser extension, and the fix is
 * different for each. CORS in particular is invisible to script, so it has to be inferred
 * and named.
 */
function classifyNetworkError(e: unknown, info: ProviderInfo): CompletionFailure {
  const detail = e instanceof Error ? e.message : String(e);

  if (e instanceof DOMException && e.name === 'AbortError') {
    return {
      ok: false,
      message: `${info.label} did not answer within ${TIMEOUT_MS / 1000} seconds.`,
      detail,
      retryable: true,
    };
  }

  if (/failed to fetch|networkerror|load failed/i.test(detail)) {
    if (info.id === 'ollama') {
      return {
        ok: false,
        message: 'Could not reach Ollama. Check it is running, and that OLLAMA_ORIGINS allows this page.',
        detail,
        retryable: true,
      };
    }

    // Name this page's own policy first, because for a long time it *was* the cause and the
    // message blamed the provider instead. connect-src listed only loopback, left over from
    // when this ran inside a CAD process, so every hosted provider failed here and the text
    // sent people to check Google's CORS policy — which was never the problem.
    return {
      ok: false,
      message:
        `Could not reach ${info.label}. Three things cause this, in order of likelihood:
` +
        `• A custom base URL whose origin is not allowed by this page's ` +
        `Content-Security-Policy. The four built-in providers are allowed; anything else has ` +
        `to be added to connect-src in index.html.
` +
        `• No network connection, or a proxy or extension blocking the request.
` +
        `• The provider is down.
` +
        `Nothing reached ${info.label} at all, so the key and the model name are not the ` +
        `cause — a bad key comes back as a rejection, not a failure to connect.`,
      detail,
      retryable: true,
    };
  }

  return { ok: false, message: `${info.label} request failed.`, detail, retryable: true };
}

/** Reads a provider's error body and surfaces its own message rather than a status code. */
async function readError(res: Response, info: ProviderInfo): Promise<CompletionFailure> {
  let detail = '';
  try {
    const text = await res.text();
    detail = text.slice(0, 800);
    const parsed = JSON.parse(text) as {
      error?: { message?: string; failed_generation?: string } | string;
    };
    if (typeof parsed.error === 'string') detail = parsed.error;
    else if (parsed.error?.message) detail = parsed.error.message;

    // What the model actually produced, when the provider rejected it for being malformed.
    //
    // Groq returns the offending text in `failed_generation` and its message tells you to
    // "see failed_generation for more details" — which is useless if nobody reads the field.
    // Without it the report is a 400 with no way to tell a truncated reply from a refusal.
    if (typeof parsed.error === 'object' && parsed.error?.failed_generation) {
      const attempt = parsed.error.failed_generation;
      detail += `\n\nWhat the model produced (${attempt.length} chars): ` +
        attempt.slice(0, 500) + (attempt.length > 500 ? '…' : '');
    }
  } catch {
    /* Body was not JSON; the raw text is still the best detail available. */
  }

  // A provider's JSON mode refusing the model's own output.
  //
  // Strict JSON mode validates the *complete* reply, so a plan that runs past the token limit
  // is rejected whole rather than returned truncated. The caller retries without it — the
  // reply is parsed leniently anyway — so this message is only ever seen if that fails too.
  if (res.status === 400 && /failed to validate json|json_validate|invalid json/i.test(detail)) {
    return {
      ok: false,
      message:
        `${info.label} rejected its own model's reply for not being valid JSON. ` +
        'Usually the plan ran past the token limit and was cut off mid-object. ' +
        'A smaller request, or a model that follows a schema more reliably, fixes it.',
      detail,
      retryable: true,
    };
  }

  // The model id is the most common thing to get wrong, and the provider's own message says
  // so far better than a generic failure would.
  if (res.status === 404 || /not found|unsupported model|does not exist/i.test(detail)) {
    return {
      ok: false,
      message:
        `${info.label} does not recognise that model id. ` +
        `Check the exact name in the provider's documentation — ` +
        `known-good options are ${info.suggestedModels.join(', ') || 'listed by the provider'}.`,
      detail,
      retryable: false,
    };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: `${info.label} rejected the API key.`, detail, retryable: false };
  }
  // 413 from an OpenAI-compatible provider is usually not about bytes.
  //
  // Groq counts the `max_tokens` you *ask for* against your tokens-per-minute allowance and
  // reports the overrun as "payload too large". Asking for a 6 000-token plan on a free tier
  // exceeded the budget before a single token was generated, so "create a house" failed while
  // "a phone" — which never calls a model at all — worked. The provider's own message names
  // the limit and what was requested, so it is passed straight through.
  if (res.status === 413) {
    return {
      ok: false,
      message:
        `${info.label} refused the request as too large. This is usually a tokens-per-minute ` +
        'limit rather than the size of the prompt — the number of tokens *requested* counts ' +
        'against it before any are generated. A smaller request or a wait of a minute clears ' +
        'it; a paid tier raises the limit.',
      detail,
      retryable: true,
    };
  }

  if (res.status === 429) {
    /*
     * Two different things arrive as 429, and telling a user the wrong one wastes their day.
     *
     * A *burst* limit is a few requests too close together: waiting a minute clears it, and
     * "wait and try again" is exactly right. A *quota* is the allowance for the day or the month
     * spent — a free tier, usually — and waiting a minute does nothing whatever. Told to wait,
     * somebody sits there retrying an account that will not answer again until tomorrow.
     *
     * The provider's own text distinguishes them, so it is read rather than flattened.
     */
    const spent = /quota|billing|exceeded your current|per day|daily limit/i.test(detail ?? '');

    return {
      ok: false,
      message: spent
        ? `${info.label} says this account's quota is spent, which waiting will not clear. `
          + 'A free tier resets on its own schedule — until then, choose a different model or '
          + 'provider, or add billing to the account.'
        : `${info.label} is rate limiting: too many requests too close together. `
          + 'Wait a minute and try again.',
      detail,
      retryable: !spent,
    };
  }
  if (res.status >= 500) {
    return { ok: false, message: `${info.label} had a server error.`, detail, retryable: true };
  }

  return { ok: false, message: `${info.label} refused the request (${res.status}).`, detail, retryable: false };
}

// ── Google Gemini ────────────────────────────────────────────────────────────

async function callGemini(
  config: ProviderConfig, req: CompletionRequest, signal: AbortSignal, started: number,
): Promise<Completion> {
  const base = config.baseUrl?.trim() || 'https://generativelanguage.googleapis.com/v1beta';
  const url = `${base}/models/${encodeURIComponent(config.model)}:generateContent`;

  // Images before the text. Every one of these APIs attends better to a question asked *about*
  // pictures already in context than to pictures appended after the question, and putting them
  // first costs nothing.
  const parts: Record<string, unknown>[] = [
    ...(req.images ?? []).map((img) => ({
      inline_data: { mime_type: img.mediaType, data: img.base64 },
    })),
    { text: req.user },
  ];

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: req.maxTokens ?? 4096,
      responseMimeType: 'application/json',
    },
  };

  // Search grounding is the only realistic way to look something up from a browser: a page
  // cannot fetch an arbitrary site because of cross-origin rules, but the model's own
  // server-side search has no such limit.
  //
  // Grounding and a forced JSON response type are mutually exclusive on this API, so when
  // search is on the JSON constraint is dropped and the reply is parsed leniently.
  if (config.allowWebSearch) {
    body.tools = [{ google_search: {} }];
    delete (body.generationConfig as Record<string, unknown>).responseMimeType;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) return readError(res, providerInfo('gemini'));

  const json = await res.json() as {
    candidates?: {
      content?: { parts?: { text?: string }[] };
      finishReason?: string;
      groundingMetadata?: { groundingChunks?: { web?: { title?: string; uri?: string } }[] };
    }[];
    promptFeedback?: { blockReason?: string };
  };

  if (json.promptFeedback?.blockReason) {
    return {
      ok: false,
      message: `Gemini declined the request (${json.promptFeedback.blockReason}).`,
      retryable: false,
    };
  }

  const candidate = json.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

  if (!text.trim()) {
    return {
      ok: false,
      message:
        candidate?.finishReason === 'MAX_TOKENS'
          ? 'Gemini hit the output limit before finishing. Try a simpler request.'
          : 'Gemini returned an empty reply.',
      retryable: true,
    };
  }

  const citations = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => ({ title: c.web?.title ?? '', uri: c.web?.uri ?? '' }))
    .filter((c) => c.uri);

  return { ok: true, text, citations, provider: 'gemini', model: config.model, ms: Date.now() - started };
}

// ── Anthropic ────────────────────────────────────────────────────────────────

async function callAnthropic(
  config: ProviderConfig, req: CompletionRequest, signal: AbortSignal, started: number,
): Promise<Completion> {
  const base = config.baseUrl?.trim() || 'https://api.anthropic.com/v1';

  const res = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      // Without this header the API refuses calls made from a web page.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: req.maxTokens ?? 4096,
      temperature: 0.2,
      system: req.system,
      messages: [{
        role: 'user',
        content: [
          ...(req.images ?? []).map((img) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 },
          })),
          { type: 'text' as const, text: req.user },
        ],
      }],
    }),
    signal,
  });

  if (!res.ok) return readError(res, providerInfo('anthropic'));

  const json = await res.json() as { content?: { type: string; text?: string }[] };
  const text = (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');

  if (!text.trim()) return { ok: false, message: 'Claude returned an empty reply.', retryable: true };
  return { ok: true, text, citations: [], provider: 'anthropic', model: config.model, ms: Date.now() - started };
}

// ── OpenAI-compatible ────────────────────────────────────────────────────────

/** Default endpoint per OpenAI-compatible provider, used when no base URL is configured. */
const COMPATIBLE_ENDPOINTS: Partial<Record<ProviderId, string>> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
};

/**
 * The per-minute token ceiling a model has been observed to have.
 *
 * Learned rather than configured, because it depends on the account's tier and nothing in the
 * app can see that. Once a 413 has told us the number, every later request for the same model
 * is sized to fit first time instead of paying a round trip to be refused again.
 */
const observedTpmLimit = new Map<string, number>();

/**
 * Reads the numbers out of a rate-limit refusal.
 *
 * Groq and the other OpenAI-compatible services state exactly what they allowed and what was
 * asked for — "Limit 6000, Requested 11234" — which is far better information than a blind
 * halving can infer. Parsing it turns "try again in a minute" into a request that fits.
 */
export function parseTokenLimit(
  body: string,
): { limit: number; requested: number; used: number; overshoot: number } | null {
  const limit = /\bLimit[ :]+(\d+)/i.exec(body);
  const requested = /\bRequested[ :]+(\d+)/i.exec(body);
  if (!limit || !requested) return null;

  const l = Number(limit[1]), r = Number(requested[1]);
  if (!Number.isFinite(l) || !Number.isFinite(r) || l <= 0) return null;

  // `Used` appears when the minute's window is already partly spent, which is the normal case
  // here: a build makes two calls seconds apart, so the second is measured against what the
  // first left behind. Without it the overshoot computes as negative and the budget would be
  // *raised* in response to a refusal — straight back into the same wall.
  const usedMatch = /\bUsed[ :]+(\d+)/i.exec(body);
  const used = usedMatch && Number.isFinite(Number(usedMatch[1])) ? Number(usedMatch[1]) : 0;

  return { limit: l, requested: r, used, overshoot: used + r - l };
}

/**
 * Rough token count for a prompt.
 *
 * Deliberately pessimistic — about three characters per token rather than the usual four — so
 * that a budget computed from it errs on the side of fitting. Undershooting the estimate is
 * what causes a second refusal, and a slightly small completion is far cheaper than that.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Leaves room for the reply's own overhead and for the estimate being a little off. */
const TOKEN_MARGIN = 256;

/** Below this a completion cannot say anything useful, so shrinking further is pointless. */
const MIN_USEFUL_BUDGET = 600;

async function callOpenAi(
  config: ProviderConfig, req: CompletionRequest, signal: AbortSignal, started: number,
  which: ProviderId = 'openai',
): Promise<Completion> {
  const base = config.baseUrl?.trim() || COMPATIBLE_ENDPOINTS[which] || COMPATIBLE_ENDPOINTS.openai!;

  const send = (strictJson: boolean, budget = req.maxTokens ?? 4096) => fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      max_tokens: budget,
      ...(strictJson ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: req.system },
        {
          role: 'user',
          // A plain string when there is nothing to look at: the array form is accepted by
          // OpenAI itself but rejected by several compatible endpoints that only implement
          // the simple shape, and there is no reason to make them all handle it for a
          // text-only request.
          content: (req.images ?? []).length === 0
            ? req.user
            : [
                ...(req.images ?? []).map((img) => ({
                  type: 'image_url' as const,
                  image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
                })),
                { type: 'text' as const, text: req.user },
              ],
        },
      ],
    }),
    signal,
  });

  // Size the request to what this model is known to allow, before asking.
  //
  // The limit counts the prompt *and* the completion budget together, so a large system
  // prompt eats into what can be asked for. Once a refusal has told us the ceiling, the
  // arithmetic is straightforward and the request fits first time.
  const asked = req.maxTokens ?? 4096;
  const known = observedTpmLimit.get(config.model);
  const promptTokens = estimateTokens(req.system) + estimateTokens(req.user);

  let budget = known
    ? Math.max(MIN_USEFUL_BUDGET, Math.min(asked, known - promptTokens - TOKEN_MARGIN))
    : asked;

  let res = await send(true, budget);

  // Refused as too large: fit to the stated limit rather than guessing.
  //
  // A single halving was not enough. On a free tier the ceiling can be well below what a
  // sixty-part assembly plan needs, and halving 8 000 to 4 000 still exceeded it — so the
  // user saw the same refusal twice and concluded the feature was broken. The provider names
  // the limit and what was requested, which is enough to compute a budget that fits exactly.
  for (let attempt = 0; res.status === 413 && attempt < 3; attempt++) {
    const parsed = parseTokenLimit(await res.clone().text());

    if (parsed && parsed.overshoot > 0) {
      // Only remember the ceiling when the window was otherwise clear. A limit learned while
      // half the minute was already spent would be recorded far too low and would throttle
      // every later request for no reason.
      if (parsed.used === 0) observedTpmLimit.set(config.model, parsed.limit);
      budget = budget - parsed.overshoot - TOKEN_MARGIN;
    } else {
      budget = Math.floor(budget / 2);
    }

    // Below this the prompt itself is the problem and no completion budget will help.
    if (budget < MIN_USEFUL_BUDGET) break;
    res = await send(true, budget);
  }

  // Still refused: the prompt alone does not fit, which is a different problem and deserves a
  // different answer than "try a smaller request".
  if (res.status === 413) {
    const ceiling = observedTpmLimit.get(config.model);
    return {
      ok: false,
      message:
        `${providerInfo(which).label} cannot fit this request` +
        (ceiling ? ` into its ${ceiling.toLocaleString()} tokens-per-minute limit` : '') +
        `. The prompt alone is about ${promptTokens.toLocaleString()} tokens, so a smaller ` +
        `completion budget does not help. Wait a minute for the window to reset, choose a ` +
        `model with a higher limit, or raise the tier.`,
      detail: (await res.clone().text()).slice(0, 400),
      retryable: true,
    };
  }

  // Strict JSON mode is an optimisation, not a requirement, so a provider refusing its own
  // model's output is not a reason to give up.
  //
  // Groq validates the whole reply before returning it, so an assembly plan that runs past
  // the token limit comes back as a 400 rather than as truncated text — the reply is
  // discarded, and the user sees "Failed to validate JSON. Please adjust your prompt" for a
  // prompt that was fine. Retried without the constraint, the same request returns the same
  // text and `extractJson` parses it, fences and prose included, as it does for every other
  // provider.
  if (!res.ok && res.status === 400) {
    const peek = (await res.clone().text()).slice(0, 400);
    if (/failed to validate json|json_validate|invalid json|response_format/i.test(peek)) {
      // With the budget that was fitted above, not the original ask — otherwise this retry
      // undoes the shrinking and walks straight back into the rate limit.
      res = await send(false, budget);
    }
  }

  if (!res.ok) return readError(res, providerInfo(which));

  const json = await res.json() as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content ?? '';

  if (!text.trim()) return { ok: false, message: 'The model returned an empty reply.', retryable: true };
  return { ok: true, text, citations: [], provider: which, model: config.model, ms: Date.now() - started };
}

// ── Ollama ───────────────────────────────────────────────────────────────────

async function callOllama(
  config: ProviderConfig, req: CompletionRequest, signal: AbortSignal, started: number,
): Promise<Completion> {
  const base = config.baseUrl?.trim() || 'http://127.0.0.1:11434';

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      format: 'json',
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: req.system },
        {
          role: 'user',
          content: req.user,
          // Ollama takes bare base64 on the message rather than as content blocks, and omits
          // the media type entirely — it sniffs the bytes.
          ...((req.images ?? []).length > 0
            ? { images: (req.images ?? []).map((img) => img.base64) }
            : {}),
        },
      ],
    }),
    signal,
  });

  if (!res.ok) return readError(res, providerInfo('ollama'));

  const json = await res.json() as { message?: { content?: string } };
  const text = json.message?.content ?? '';

  if (!text.trim()) return { ok: false, message: 'The local model returned an empty reply.', retryable: true };
  return { ok: true, text, citations: [], provider: 'ollama', model: config.model, ms: Date.now() - started };
}

// ── JSON extraction ──────────────────────────────────────────────────────────

/**
 * Pulls a JSON object out of a model's reply.
 *
 * Even with a JSON response format, models wrap output in prose or fences often enough that
 * a strict `JSON.parse` fails on replies that are otherwise perfectly good. Recovering the
 * object is not being lax about correctness — the result is still validated against the
 * schema afterwards — it just avoids discarding a usable answer over punctuation.
 */
export function extractJson<T>(text: string): T | null {
  const attempts: string[] = [text.trim()];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1].trim());

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) attempts.push(text.slice(firstBrace, lastBrace + 1));

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }
  return null;
}

/** Quick reachability check, so settings can be verified before they are relied on. */
export async function testConnection(config: ProviderConfig): Promise<Completion> {
  return complete(config, {
    system: 'You reply only with JSON.',
    user: 'Reply with exactly {"ok":true}',
    maxTokens: 64,
  });
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

/**
 * How the client decides whether an orchestrator exists.
 *
 * The decision matters more than it looks. Getting it wrong in one direction leaves the
 * application retrying a socket that will never open; in the other, it fetches `/health`
 * against whatever origin happens to be serving the bundle and writes a 404 to the console on
 * every load — so a perfectly working static deployment appears to fail at startup.
 *
 * The orchestrator announces itself in exactly two ways, and both are tested here.
 */

const setSearch = (search: string) => {
  const url = new URL(`http://example.test/${search}`);
  vi.stubGlobal('location', {
    ...window.location, href: url.href, origin: url.origin, search: url.search,
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { DATUM_SESSION?: unknown }).DATUM_SESSION;
});

describe('finding an orchestrator', () => {
  it('does not go looking when nothing announced one', async () => {
    // A static host — GitHub Pages, a CDN, a file server. There is no orchestrator, and
    // asking costs a console error on every load.
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    setSearch('');

    await api.init();

    expect(fetched).not.toHaveBeenCalled();
    expect(api.demo).toBe(true);
  });

  it('looks when a session was injected into the page', async () => {
    (window as { DATUM_SESSION?: unknown }).DATUM_SESSION = { port: 51234, token: 'abc' };
    const fetched = vi.fn(async (url: string) => { void url; return new Response('{}', { status: 500 }); });
    vi.stubGlobal('fetch', fetched);

    await api.init();

    expect(fetched).toHaveBeenCalled();
    expect(String(fetched.mock.lastCall?.[0])).toContain('51234');
  });

  it('looks when the Studio window was opened with a token', async () => {
    const fetched = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetched);
    setSearch('?surface=studio&token=xyz');

    await api.init();

    expect(fetched).toHaveBeenCalled();
  });

  it('falls back rather than throwing when the probe fails', async () => {
    (window as { DATUM_SESSION?: unknown }).DATUM_SESSION = { port: 51234, token: 'abc' };
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused'); }));

    await expect(api.init()).resolves.toBeUndefined();
    expect(api.demo).toBe(true);
  });

  it('does not mistake a static host answering /health for an orchestrator', async () => {
    // Any static server will serve index.html for an unknown path and answer 200. Only the
    // handshake payload proves there is something on the other end.
    (window as { DATUM_SESSION?: unknown }).DATUM_SESSION = { port: 51234, token: 'abc' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html></html>', {
      status: 200, headers: { 'Content-Type': 'text/html' },
    })));

    await api.init();
    expect(api.demo).toBe(true);
  });
});

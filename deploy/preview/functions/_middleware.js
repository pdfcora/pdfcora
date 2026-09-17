/**
 * Password gate for the private preview of the site (Cloudflare Pages project
 * `pdfcora-preview`). It runs in front of every request, static files included.
 *
 * It fails closed: with no PREVIEW_PASSWORD configured, nothing is served. It is
 * deployed only to the preview project — the public `pdfcora` project never
 * carries it, so a mistake here cannot hide the real site or expose the preview.
 */

const encoder = new TextEncoder();

async function sameSecret(given, expected) {
  // Hashing first gives equal-length inputs, which timingSafeEqual requires.
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function passwordFrom(request) {
  const header = request.headers.get('Authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return null;
  let decoded;
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }
  // "user:password" — the user name is ignored, and a password may contain ':'.
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : decoded.slice(colon + 1);
}

export async function onRequest({ request, env, next }) {
  const expected = env.PREVIEW_PASSWORD;
  if (!expected) {
    return new Response('Preview is not configured.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  const given = passwordFrom(request);
  if (given !== null && (await sameSecret(given, expected))) {
    const response = await next();
    // Keep the preview out of search engines even for someone who has the password.
    const headers = new Headers(response.headers);
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  return new Response('Password required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="PDFCora preview", charset="UTF-8"',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

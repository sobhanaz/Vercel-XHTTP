export const config = {
  // Serverless runtime is better for cost because billing pauses 
  // while waiting for the target server to respond.
  runtime: 'nodejs', 
};

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

export default async function handler(req) {
  if (!TARGET_BASE) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  const controller = new AbortController();
  
  try {
    const url = new URL(req.url);
    const targetUrl = TARGET_BASE + url.pathname + url.search;

    const outHeaders = new Headers();
    // Pass through the client's real IP
    let clientIp = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for");

    for (const [k, v] of req.headers) {
      const lowerK = k.toLowerCase();
      if (STRIP_HEADERS.has(lowerK) || lowerK.startsWith("x-vercel-")) {
        continue;
      }
      outHeaders.set(k, v);
    }
    
    if (clientIp) {
      outHeaders.set("x-forwarded-for", clientIp);
    }

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: outHeaders,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      redirect: "manual",
      signal: controller.signal,
      // duplex: 'half' enables high-speed streaming for request bodies
      duplex: 'half', 
    });

    // We return the response body directly as a stream. 
    // This provides the lowest latency (max speed).
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

  } catch (err) {
    controller.abort();
    console.error("Relay error:", err);
    return new Response("Bad Gateway", { status: 502 });
  }
}
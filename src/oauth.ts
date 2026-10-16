/**
 * Minimal OAuth 2.1 Authorization Code + PKCE flow, so ChatGPT's "OAuth" custom-connector
 * option can be used against this single-tenant server instead of "no authentication".
 *
 * Deliberately simplified for a single operator / single Taiga bot identity:
 *  - One fixed client (OAUTH_CLIENT_ID/OAUTH_CLIENT_SECRET), entered manually in ChatGPT's
 *    "user-defined client" connector setup — no dynamic client registration.
 *  - The "password" on the login form IS the MCP_BEARER_TOKEN, and the access_token handed
 *    back at the end of the dance is that same MCP_BEARER_TOKEN — there's only one secret in
 *    the whole system. This lets the existing static-bearer-token check on /mcp stay as-is.
 *  - No refresh tokens: the issued access_token has a long expiry instead. Acceptable here
 *    because the token never actually rotates — reissuing via OAuth or using it directly as a
 *    static bearer token both reach the same secret.
 *  - Authorization codes are one-time-use and kept in an in-memory Map (fine for a single
 *    CapRover instance; a restart mid-login just means the user retries).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express, { Express, Request } from "express";

interface PendingCode {
  codeChallenge: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
}

const CODE_TTL_MS = 5 * 60 * 1000;
const authCodes = new Map<string, PendingCode>();

function cleanupExpiredCodes(): void {
  const now = Date.now();
  for (const [code, data] of authCodes) {
    if (data.expiresAt < now) authCodes.delete(code);
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function baseUrlFor(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

function isAllowedRedirectUri(uri: string | undefined): uri is string {
  if (!uri) return false;
  const allowedPrefix = process.env.OAUTH_ALLOWED_REDIRECT_PREFIX || "https://chatgpt.com/connector/oauth/";
  return uri.startsWith(allowedPrefix);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function renderLoginForm(params: {
  responseType: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  error?: string;
}): string {
  const f = (v: string) => escapeHtml(v);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Taiga MCP — Sign in</title>
<style>
body{font-family:system-ui,sans-serif;max-width:360px;margin:80px auto;padding:0 16px;color:#111}
input{width:100%;box-sizing:border-box;padding:10px;margin:8px 0;font-size:16px}
button{width:100%;padding:10px;font-size:16px;cursor:pointer}
.error{color:#c00;font-size:14px}
</style></head>
<body>
<h2>Taiga MCP</h2>
<p>Enter the server access token to authorize this connection.</p>
${params.error ? `<p class="error">${f(params.error)}</p>` : ""}
<form method="POST" action="/authorize">
  <input type="hidden" name="response_type" value="${f(params.responseType)}">
  <input type="hidden" name="client_id" value="${f(params.clientId)}">
  <input type="hidden" name="redirect_uri" value="${f(params.redirectUri)}">
  <input type="hidden" name="state" value="${f(params.state)}">
  <input type="hidden" name="code_challenge" value="${f(params.codeChallenge)}">
  <input type="hidden" name="code_challenge_method" value="${f(params.codeChallengeMethod)}">
  <input type="hidden" name="scope" value="${f(params.scope)}">
  <input type="password" name="password" placeholder="Access token" autofocus required>
  <button type="submit">Authorize</button>
</form>
</body></html>`;
}

export function registerOAuthRoutes(app: Express): void {
  const clientId = process.env.OAUTH_CLIENT_ID!;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET!;
  const bearerToken = process.env.MCP_BEARER_TOKEN!;
  const urlEncoded = express.urlencoded({ extended: false });

  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const base = baseUrlFor(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    });
  });

  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => {
    const base = baseUrlFor(req);
    res.json({ resource: `${base}/mcp`, authorization_servers: [base] });
  });

  app.get("/authorize", (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const responseType = q.response_type ?? "";
    const clientIdParam = q.client_id ?? "";
    const redirectUri = q.redirect_uri;
    const state = q.state ?? "";
    const codeChallenge = q.code_challenge ?? "";
    const codeChallengeMethod = q.code_challenge_method ?? "";
    const scope = q.scope ?? "";

    if (responseType !== "code" || !codeChallenge || codeChallengeMethod !== "S256") {
      res.status(400).send("Unsupported request: response_type must be 'code' with PKCE (code_challenge_method=S256).");
      return;
    }
    if (clientIdParam !== clientId) {
      res.status(400).send("Unknown client_id.");
      return;
    }
    if (!isAllowedRedirectUri(redirectUri)) {
      res.status(400).send("redirect_uri not allowed.");
      return;
    }

    res.status(200).send(
      renderLoginForm({
        responseType,
        clientId: clientIdParam,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
        scope,
      })
    );
  });

  app.post("/authorize", urlEncoded, (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    const responseType = body.response_type ?? "";
    const clientIdParam = body.client_id ?? "";
    const redirectUri = body.redirect_uri;
    const state = body.state ?? "";
    const codeChallenge = body.code_challenge ?? "";
    const codeChallengeMethod = body.code_challenge_method ?? "";
    const scope = body.scope ?? "";
    const password = body.password ?? "";

    if (clientIdParam !== clientId || !isAllowedRedirectUri(redirectUri)) {
      res.status(400).send("Invalid request.");
      return;
    }

    if (!password || !safeEqual(password, bearerToken)) {
      res
        .status(401)
        .send(
          renderLoginForm({
            responseType,
            clientId: clientIdParam,
            redirectUri,
            state,
            codeChallenge,
            codeChallengeMethod,
            scope,
            error: "Incorrect token. Try again.",
          })
        );
      return;
    }

    cleanupExpiredCodes();
    const code = randomBytes(32).toString("hex");
    authCodes.set(code, {
      codeChallenge,
      clientId: clientIdParam,
      redirectUri,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state) redirect.searchParams.set("state", state);
    res.redirect(302, redirect.toString());
  });

  app.post("/token", urlEncoded, (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    let reqClientId = body.client_id;
    let reqClientSecret = body.client_secret;

    const authHeader = req.header("authorization");
    if (authHeader?.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
      const separatorIndex = decoded.indexOf(":");
      if (separatorIndex >= 0) {
        reqClientId = reqClientId ?? decoded.slice(0, separatorIndex);
        reqClientSecret = reqClientSecret ?? decoded.slice(separatorIndex + 1);
      }
    }

    if (reqClientId !== clientId || reqClientSecret !== clientSecret) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }
    if (body.grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }
    if (!body.code) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing code." });
      return;
    }

    const pending = authCodes.get(body.code);
    if (!pending || pending.expiresAt < Date.now()) {
      res.status(400).json({ error: "invalid_grant", error_description: "Code expired or unknown." });
      return;
    }
    authCodes.delete(body.code);

    if (pending.redirectUri !== body.redirect_uri) {
      res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch." });
      return;
    }

    const verifierHash = createHash("sha256")
      .update(body.code_verifier ?? "")
      .digest("base64url");
    if (verifierHash !== pending.codeChallenge) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed." });
      return;
    }

    res.json({
      access_token: bearerToken,
      token_type: "Bearer",
      // No refresh flow implemented: the token doesn't rotate, so a long expiry avoids
      // ChatGPT needing to refresh it.
      expires_in: 34560000,
    });
  });
}

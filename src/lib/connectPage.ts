// Shared visual shell for every browser-facing connect page — the field-collection form
// (connection_routes.ts), its success/error states, and the OAuth callback result page
// (webhook_routes.ts). One place so all of them read as one product, not three different plain-HTML
// pages improvised separately. Still deliberately zero JS/framework (per "no client hustle") — this is
// real CSS, not a UI library.

const STYLES = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f5f6f8;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #111827;
  }
  .card {
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06);
    padding: 40px 32px;
    width: 100%;
    max-width: 380px;
    text-align: center;
  }
  .badge {
    width: 56px; height: 56px;
    border-radius: 50%;
    background: #111827;
    color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; font-weight: 600;
    margin: 0 auto 20px;
  }
  .badge.success { background: #16a34a; }
  .badge.error { background: #dc2626; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
  p.subtitle { font-size: 14px; color: #6b7280; margin: 0 0 24px; line-height: 1.5; }
  .field { text-align: left; margin-bottom: 16px; }
  .field label { display: block; font-size: 13px; font-weight: 500; color: #374151; margin-bottom: 6px; }
  .field input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .field input:focus { border-color: #111827; box-shadow: 0 0 0 3px rgba(17,24,39,0.08); }
  button {
    width: 100%;
    padding: 11px;
    background: #111827;
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }
  button:hover { background: #1f2937; }
  .error-banner {
    background: #fef2f2;
    color: #b91c1c;
    border: 1px solid #fecaca;
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 13px;
    margin-bottom: 16px;
    text-align: left;
  }
  .footer { margin-top: 20px; font-size: 12px; color: #9ca3af; }
`;

// Not a full sanitizer — just enough that a provider-supplied error message (external, not fully
// trusted) can't break out of the HTML it's interpolated into.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderPage(title: string, bodyHtml: string): Response {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLES}</style></head>
<body><div class="card">${bodyHtml}</div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function successPage(appName: string): Response {
  return renderPage(
    "Connected",
    `<div class="badge success">&#10003;</div>
     <h1>Connected to ${escapeHtml(appName)}</h1>
     <p class="subtitle">You can close this window and go back to what you were doing.</p>`,
  );
}

export function errorPage(message: string): Response {
  return renderPage(
    "Connection failed",
    `<div class="badge error">&#10005;</div>
     <h1>Connection failed</h1>
     <p class="subtitle">${escapeHtml(message)}</p>`,
  );
}

// MCP login: types an access key into a real page instead of hand-editing an MCP client's JSON config
// with raw env vars (src/mcp/loginRoutes.ts). Same visual shell as every other page here.

export function mcpLoginFormPage(opts: { errorMessage?: string; userId?: string; apps?: string }): Response {
  const errorBanner = opts.errorMessage ? `<div class="error-banner">${escapeHtml(opts.errorMessage)}</div>` : "";
  return renderPage(
    "Connect MCP",
    `<div class="badge">MCP</div>
     <h1>Connect this MCP server</h1>
     <p class="subtitle">Enter the access key for this tool provider to get your personal MCP URL.</p>
     ${errorBanner}
     <form method="POST" action="/mcp/login">
       <div class="field">
         <label for="access_key">Access key</label>
         <input id="access_key" name="access_key" type="password" required autocomplete="off">
       </div>
       <div class="field">
         <label for="user_id">Existing user ID (optional)</label>
         <input id="user_id" name="user_id" type="text" placeholder="usr_... — leave blank to create a new one" autocomplete="off" value="${escapeHtml(opts.userId ?? "")}">
       </div>
       <div class="field">
         <label for="apps">Limit to apps (optional)</label>
         <input id="apps" name="apps" type="text" placeholder="e.g. gmail,slack — leave blank for all" autocomplete="off" value="${escapeHtml(opts.apps ?? "")}">
       </div>
       <button type="submit">Continue</button>
     </form>
     <div class="footer">Internal use only — this key is not for public distribution. Save the user ID from your last login here to reconnect as the same identity (same connections) instead of starting fresh.</div>`,
  );
}

// `token` is shown once, in plaintext, on purpose — it's the caller's only chance to copy it (we never
// display it again; resolveMcpLoginToken only ever gets checked, not read back for display elsewhere).
// No copy-to-clipboard JS button — deliberately zero JS across every page in this file (see file header).
export function mcpLoginSuccessPage(opts: { mcpUrl: string; token: string; userId: string; reused: boolean }): Response {
  return renderPage(
    "MCP connected",
    `<div class="badge success">&#10003;</div>
     <h1>Your MCP server is ready</h1>
     <p class="subtitle">Paste these into your MCP client's remote-server config. The token is shown once — copy it now.</p>
     <div class="field">
       <label>Server URL</label>
       <input type="text" readonly value="${escapeHtml(opts.mcpUrl)}">
     </div>
     <div class="field">
       <label>Bearer token</label>
       <input type="text" readonly value="${escapeHtml(opts.token)}">
     </div>
     <div class="field">
       <label>User ID${opts.reused ? " (reused — same connections as before)" : " (new — save this to log back in as this identity)"}</label>
       <input type="text" readonly value="${escapeHtml(opts.userId)}">
     </div>
     <div class="footer">Send the token as <code>Authorization: Bearer &lt;token&gt;</code>, or append <code>?token=&lt;token&gt;</code> to the URL if your client only accepts a plain URL. Next time, paste the User ID above into the login form's "Existing user ID" field to reconnect as the same identity instead of starting over.</div>`,
  );
}

export interface FormField {
  name: string;
  label: string;
  required: boolean;
  secret: boolean;
}

export function fieldFormPage(opts: { appName: string; fields: FormField[]; actionUrl: string; errorMessage?: string }): Response {
  const errorBanner = opts.errorMessage ? `<div class="error-banner">${escapeHtml(opts.errorMessage)}</div>` : "";
  const inputs = opts.fields
    .map(
      (f) => `
    <div class="field">
      <label for="${escapeHtml(f.name)}">${escapeHtml(f.label)}${f.required ? "" : " (optional)"}</label>
      <input id="${escapeHtml(f.name)}" name="${escapeHtml(f.name)}" type="${f.secret ? "password" : "text"}" ${f.required ? "required" : ""} autocomplete="off">
    </div>`,
    )
    .join("");

  return renderPage(
    `Connect ${opts.appName}`,
    `<div class="badge">${escapeHtml(opts.appName.charAt(0).toUpperCase())}</div>
     <h1>Connect ${escapeHtml(opts.appName)}</h1>
     <p class="subtitle">Enter your credentials to link your ${escapeHtml(opts.appName)} account.</p>
     ${errorBanner}
     <form method="POST" action="${opts.actionUrl}">
       ${inputs}
       <button type="submit">Connect</button>
     </form>
     <div class="footer">Secured connection — your data is encrypted</div>`,
  );
}

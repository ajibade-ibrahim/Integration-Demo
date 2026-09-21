/**
 * GET /api/oauth/mock/authorize
 *
 * The mock provider's consent screen. Stands in for HubSpot's or Salesforce's,
 * and renders the exact scope list it was asked for — which is the clearest
 * demonstration of the platform's central rule: pick identity alone and you see
 * only identity scopes; add support and ticket scopes appear.
 *
 * Plain HTML rather than a React page: this is pretending to be a different
 * system, and routing it through the app's own layout would undercut that.
 */

import { NextResponse } from "next/server";
import { isMockEnabled } from "@/core/providers/mock/provider";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Human gloss for the scopes the mock declares. */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "crm.objects.companies.read": "View companies and their properties",
  "crm.objects.contacts.read": "View contacts and their properties",
  "crm.objects.tickets.read": "View support tickets",
  "crm.objects.deals.read": "View deals, subscriptions and contract terms",
  "crm.schemas.read": "View the list of available fields",
  "billing.invoices.read": "View invoices and payment history",
};

export async function GET(request: Request): Promise<NextResponse> {
  if (!isMockEnabled()) {
    return NextResponse.json(
      { error: "Mock provider is disabled" },
      { status: 404 }
    );
  }

  const params = new URL(request.url).searchParams;
  const redirectUri = params.get("redirect_uri");
  const state = params.get("state") ?? "";
  const scopes = (params.get("scope") ?? "").split(" ").filter((s) => s !== "");

  if (redirectUri === null || redirectUri === "") {
    return NextResponse.json({ error: "redirect_uri is required" }, { status: 400 });
  }

  const approve = new URL(redirectUri);
  approve.searchParams.set("code", `mock-code-${Date.now()}`);
  approve.searchParams.set("state", state);

  const deny = new URL(redirectUri);
  deny.searchParams.set("error", "access_denied");
  deny.searchParams.set("state", state);

  const scopeItems = scopes
    .map((scope) => {
      const description = SCOPE_DESCRIPTIONS[scope] ?? "Access this data";
      return `<li><code>${escapeHtml(scope)}</code><span>${escapeHtml(description)}</span></li>`;
    })
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mock CRM — Authorize</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#f1f5f9; color:#0f172a;
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .card { width:min(30rem,92vw); background:#fff; border:1px solid #e2e8f0;
          border-radius:14px; padding:2rem; box-shadow:0 10px 30px rgb(15 23 42 / .07); }
  .brand { display:flex; align-items:center; gap:.6rem; font-weight:650; margin-bottom:1.4rem; }
  .dot { width:26px; height:26px; border-radius:7px; background:#f97316; }
  h1 { font-size:1.15rem; margin:0 0 .4rem; }
  p.lede { margin:0 0 1.3rem; color:#475569; }
  ul { list-style:none; margin:0 0 1.6rem; padding:0; border-top:1px solid #f1f5f9; }
  li { display:flex; flex-direction:column; gap:.15rem; padding:.7rem 0;
       border-bottom:1px solid #f1f5f9; }
  code { font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace; color:#0f172a; }
  li span { color:#64748b; font-size:13px; }
  .actions { display:flex; gap:.6rem; }
  a { flex:1; text-align:center; padding:.65rem 1rem; border-radius:9px;
      text-decoration:none; font-weight:560; }
  .approve { background:#f97316; color:#fff; }
  .deny { background:#f8fafc; color:#475569; border:1px solid #e2e8f0; }
  .note { margin:1.3rem 0 0; font-size:12.5px; color:#94a3b8; text-align:center; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand"><div class="dot"></div> Mock CRM</div>
    <h1>Integration Demo wants access to your account</h1>
    <p class="lede">It is requesting these permissions:</p>
    <ul>${scopeItems || "<li><span>No scopes requested</span></li>"}</ul>
    <div class="actions">
      <a class="deny" href="${escapeHtml(deny.toString())}">Cancel</a>
      <a class="approve" href="${escapeHtml(approve.toString())}">Allow access</a>
    </div>
    <p class="note">Simulated consent screen — no real account is involved.</p>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

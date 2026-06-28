# LinkedIn API Application Guide — Auto-posting to the MACPrep Company Page

**Goal:** Let the MACPrep server (Express on Render) publish text + link posts to the
**MACPrep company LinkedIn Page** automatically (a "weekly batcher" job, ~1 post/day),
replacing the current browser-automation / manual-markdown approach.

**Status of this document:** Research + preparation only. No LinkedIn account, app, or
access request has been created or submitted. Every step that *must* be done by a human is
marked **USER-ONLY**; everything that has been (or can be) pre-prepared is marked
**PREP-DONE**.

All API facts below were verified against official LinkedIn / Microsoft Learn developer
docs (June 2026). Sources are listed at the end. Items I could **not** fully verify are
flagged in the **Blockers & Uncertainties** section — read that before you start.

---

## 0. TL;DR — what you're requesting and what it costs you

| Thing | Answer |
| --- | --- |
| **Developer product to request** | **Community Management API** (the *only* product that grants posting **as an organization/company Page**). |
| **Scope to post as the org** | **`w_organization_social`** (write). Add **`r_organization_social`** (read your own posts) and **`rw_organization_admin`** (look up the org URN / admin role) as useful companions. |
| **Posting endpoint** | `POST https://api.linkedin.com/rest/posts` with `author: "urn:li:organization:130213953"`. |
| **Token model** | OAuth 2.0 3-legged. Access token **60 days**. Refresh token **365 days** — **but only if your app is granted programmatic refresh tokens** (see §6, this is the main uncertainty). |
| **Approval** | Manual LinkedIn review. **Development Tier** first (enough for ~1 post/day), then optional **Standard Tier** (requires a screencast). Expect **~1–4 weeks** of review, sometimes longer. |
| **Hard gate** | A **super admin of the MACPrep Page must "verify" (associate) the app with the Page** before LinkedIn will approve. Jake is the admin, so this is fine — but it's a required manual click. |

> ⚠️ **The single biggest caveat:** LinkedIn states the Community Management APIs are
> "only available to **registered legal organizations for commercial use cases only**,"
> require a **verified business email** (personal emails are rejected), and ask for your
> org's **legal name, registered address, website, and privacy policy**. MACPrep LLC
> (Roswell, GA) with `jake@macprep.org`-style business email, `https://www.macprep.org`,
> and the existing privacy policy at `/privacy.html` should satisfy this — but you must
> apply with the **business email on the macprep.org domain**, not a personal Gmail.

---

## 1. The product and scopes (verified)

### Product
You must request the **Community Management API** product in the LinkedIn Developer Portal.
This is a *vetted* product (manual review) with two tiers (Development, Standard). It is the
product that exposes the **Posts API** with an **organization author**.

Products you do **not** need for this goal (and why):
- **"Share on LinkedIn"** → only posts as a **member** (a person), not a company Page.
- **"Sign In with LinkedIn using OpenID Connect"** → authentication/identity only; no posting.
- **"Marketing Developer Platform (MDP)" / Advertising API** → for paid ads & campaign
  management. Overkill here. (Note: MDP partners are the ones who get programmatic refresh
  tokens — see §6.)

### Scopes (exact current names, verified against the Posts API permissions table)
| Scope | What it grants | Needed? |
| --- | --- | --- |
| `w_organization_social` | **Post**, comment, like **on behalf of an organization.** Requires the authenticated member to have an `ADMINISTRATOR`, `DIRECT_SPONSORED_CONTENT_POSTER`, or `CONTENT_ADMIN` role on the Page. | **Yes — this is the one that lets you post.** |
| `r_organization_social` | **Read** the organization's posts/comments/likes (verify a post went out, read engagement). | Recommended. |
| `rw_organization_admin` | Manage Page + **look up the organization** (admin role, org URN, reporting). Used to confirm the org URN via the API. | Recommended (handy for §3 URN confirmation; not strictly required to post). |
| `w_member_social` | Post as the **logged-in person** (not the company). | **No** — that's the member path, not the org path. |

When you build the OAuth consent URL, scopes are **space-delimited and URL-encoded** in the
`scope` parameter, e.g.
`scope=r_organization_social%20w_organization_social%20rw_organization_admin`.
The member must consent to **all** requested scopes at once (no partial selection).

---

## 2. Confirming the MACPrep organization URN/ID (verified)

- The numeric ID in a company Page URL **is** the organization ID. For
  `https://www.linkedin.com/company/130213953/`, the org ID is **`130213953`** and the URN
  is **`urn:li:organization:130213953`**. This is the value you put in the `author` field.
- **Sanity-check it programmatically** (once you have a token with `rw_organization_admin`
  and an admin role on the Page):
  ```bash
  curl -X GET 'https://api.linkedin.com/rest/organizations/130213953' \
    -H 'Authorization: Bearer {TOKEN}' \
    -H 'X-Restli-Protocol-Version: 2.0.0' \
    -H 'Linkedin-Version: 202506'
  ```
  A `200` with `"$URN": "urn:li:organization:130213953"` and `vanityName`/`localizedName`
  matching MACPrep confirms it. A `403` means the authenticated member isn't an admin of
  that Page (fix the role, see §3).
- Alternatively, list the organizations the logged-in member administers via the
  Organization Access Control API (`organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`)
  to discover the URN without knowing the number.

---

## 3. Step-by-step: create the app + request access

Legend: **USER-ONLY** = only Jake can do it (requires his LinkedIn login / a human click).
**PREP-DONE** = drafted/prepared in this repo and ready to paste or reuse.

### Phase A — Prerequisites (all USER-ONLY, but quick)
1. **USER-ONLY — Be a Page admin.** Confirm Jake is a **Super Admin** of the MACPrep
   Page (`/company/130213953/`). Super Admin is required both to *verify the app* and to
   *grant the posting scope*. (Page admin settings → "Admin tools" → "Manage admins".)
2. **USER-ONLY — Have a business email on the macprep.org domain.** e.g.
   `jake@macprep.org`. Personal Gmail will fail the vetting. LinkedIn verifies this email.
3. **PREP-DONE — Legal/business details ready:** Legal name *MACPrep LLC*; registered
   address *Roswell, GA, USA* (matches `MAILING_ADDRESS` in the app); website
   `https://www.macprep.org`; privacy policy `https://www.macprep.org/privacy.html`;
   terms `https://www.macprep.org/terms.html`.

### Phase B — Create the developer app (USER-ONLY)
4. **USER-ONLY** — Go to <https://www.linkedin.com/developers/apps> → **Create app**.
   - **App name:** `MACPrep Page Publisher` (must **not** contain "Linked"/"In"/LinkedIn
     or Microsoft names/logos — a documented rejection reason).
   - **LinkedIn Page:** select the **MACPrep** company Page (`/company/130213953/`).
     Associating the app with the Page here is what later lets the Super Admin "verify" it.
   - **App logo:** use `macprep_logo.png` / `macprep_icon.png` from the repo root.
   - Accept the **LinkedIn API Terms of Use**.
5. **USER-ONLY — Verify the app against the Page.** On the app's **Settings** tab there is a
   **"Verify"** button that generates a verification URL. A **Super Admin of the MACPrep
   Page must open that URL and click to confirm** the association. (This is the
   "page-verification link" the access process requires.) Help article:
   <https://www.linkedin.com/help/linkedin/answer/a548360/associate-an-app-with-a-linkedin-page>
6. **USER-ONLY** — On the **Auth** tab, note the **Client ID** and **Client Secret**
   (store the secret as an env var, never in git — see §8). Add the **redirect URL**:
   ```
   https://www.macprep.org/auth/linkedin/callback
   ```
   (Must be absolute HTTPS, no fragment, params ignored — this matches LinkedIn's rules.)

### Phase C — Request the Community Management API (USER-ONLY submit; copy PREP-DONE)
7. **USER-ONLY** — On the app's **Products** tab, find **Community Management API** →
   **Request access** → this opens the **Development Tier access request form**.
   - If the option is **grayed out**, it's because LinkedIn only grants Community Management
     **Development Tier** to apps that **don't already have other API products**. Use a fresh
     app dedicated to this (which is what step 4 creates).
8. **USER-ONLY — Fill the form**, pasting the **use-case copy from §4 (PREP-DONE)**.
   Provide business email, legal name, address, website, privacy policy URL.
9. **USER-ONLY — Submit.** LinkedIn reviews: approved use case, verified business email,
   verified org + domain, and **app verified by the Page** (step 5). Expect **~1–4 weeks**.
   - If **rejected**, you **cannot re-apply with the same app** — you create a *new* app and
     submit a fresh Development Tier request. So get the details right the first time.
10. **On approval → Development Tier.** Default rate limits (currently 500 requests/app/day,
    100/member/day) are *far* more than ~1 post/day needs. **Development Tier is enough to
    ship the weekly batcher.**

### Phase D — (Optional) Standard Tier upgrade (USER-ONLY)
11. Only needed if you outgrow Development limits or want full production scale. Requires a
    **downloadable, high-resolution screencast** demonstrating: a user completing the OAuth
    flow, **posting to the Page via the app**, and how any member data (e.g. comments) is
    displayed. Narration recommended. Reviewed for use case, privacy policy, and compliance.
    For ~1 post/day you can likely **skip this**.

---

## 4. DRAFT "use case description" copy (PREP-DONE — paste into the access form)

> *Paste/adapt the following into the "describe your use case" field(s). Keep it factual:
> first-party, low-volume, educational.*

---

**Company & product.** MACPrep LLC operates MACPrep (https://www.macprep.org), a board-review
question-bank platform for Certified Anesthesiologist Assistants and students preparing for
the NCCAA certification exam. The company is a registered LLC based in Roswell, Georgia, USA,
and operates the official MACPrep LinkedIn Page. We are requesting Community Management API
access strictly to manage **our own** company Page — we do not manage Pages on behalf of any
third party.

**Use case — first-party page management.** We will use the Community Management API to
publish a low volume of **organic, educational posts (approximately one per day)** to the
MACPrep company Page from our own backend. Each post is short professional commentary — a
board-review study tip, a sample question concept, or an announcement — usually with a link
back to a relevant page on macprep.org. This replaces a manual posting workflow and lets our
small team keep the Page active with consistent, professionally relevant content. We will use
the Posts API with our organization as the author and the `w_organization_social` scope, with
`r_organization_social` to confirm posts published successfully. Only an administrator of the
MACPrep Page (the company founder) will authorize the application via OAuth.

**Data handling.** We do not collect, store, or display LinkedIn member personal data. The
integration is outbound-only: it authenticates one admin via OAuth and publishes content
authored by us. Access tokens and refresh tokens are stored encrypted at rest in our backend
database (Supabase/Postgres) and are never exposed to end users or third parties. Our privacy
policy is available at https://www.macprep.org/privacy.html.

---

## 5. The posting API (verified) — text + link to macprep.org

**Endpoint:** `POST https://api.linkedin.com/rest/posts`
(Note: `api.linkedin.com/rest/...`, **not** `/v2/...`. The Posts API replaces the legacy
`ugcPosts` API.)

**Required headers:**
```
Authorization: Bearer {ORG_ACCESS_TOKEN}
X-Restli-Protocol-Version: 2.0.0
Linkedin-Version: 202506        # YYYYMM. Use a recent, supported version. Bump periodically.
Content-Type: application/json
```
> `Linkedin-Version` is a real, required header in `YYYYMM` form. Pin it to a recent
> supported version (e.g. `202506`) and update it a few times a year; old versions get sunset.

### 5a. Minimal **text + link** post (recommended shape for the batcher)

LinkedIn renders a real link preview when you use a `content.article` block. **Important
gotcha (verified):** the Posts API does **not** scrape the URL — you must supply `title` and
`description` yourself, and (optionally) a `thumbnail` image URN uploaded via the Images API.

```json
{
  "author": "urn:li:organization:130213953",
  "commentary": "Board-review tip: the MAC of an inhaled anesthetic falls ~6% per decade of age. Drill the high-yield pharmacology that shows up on the NCCAA exam. New practice set this week 👇",
  "visibility": "PUBLIC",
  "distribution": {
    "feedDistribution": "MAIN_FEED",
    "targetEntities": [],
    "thirdPartyDistributionChannels": []
  },
  "content": {
    "article": {
      "source": "https://www.macprep.org/",
      "title": "MACPrep — NCCAA Board Review for Anesthesiologist Assistants",
      "description": "Practice questions, rationales, and study analytics for the CAA certification exam."
    }
  },
  "lifecycleState": "PUBLISHED",
  "isReshareDisabledByAuthor": false
}
```

### 5b. Even simpler — **text only**, link in the commentary
If you don't want to manage `title`/`description`, drop `content` entirely and just put the
URL in `commentary`. LinkedIn usually auto-creates a preview card from a bare URL in the text.
This is the most robust for a fully automated batcher:

```json
{
  "author": "urn:li:organization:130213953",
  "commentary": "New free practice set is live. Board-review tip of the day → https://www.macprep.org/",
  "visibility": "PUBLIC",
  "distribution": {
    "feedDistribution": "MAIN_FEED",
    "targetEntities": [],
    "thirdPartyDistributionChannels": []
  },
  "lifecycleState": "PUBLISHED",
  "isReshareDisabledByAuthor": false
}
```

**Success response:** HTTP **`201`**. The new post's URN is returned in the **`x-restli-id`**
response **header** (e.g. `urn:li:share:6844785523593134080`) — the body may be empty, so read
the header. The live post is viewable at
`https://www.linkedin.com/feed/update/{urn}/`.

**Relevant error codes:** `403 ACCESS_DENIED` = missing scope or the member lacks an admin
role on the Page; `401 EMPTY_ACCESS_TOKEN` = bad/expired token; `429 TOO_MANY_REQUESTS` =
rate limited (won't happen at 1/day).

---

## 6. Token model (verified) — and the one thing to confirm

- **Flow:** OAuth 2.0 **3-legged Authorization Code** flow.
  1. Send the admin to
     `GET https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id={ID}&redirect_uri=https%3A%2F%2Fwww.macprep.org%2Fauth%2Flinkedin%2Fcallback&state={csrf}&scope=r_organization_social%20w_organization_social%20rw_organization_admin`
  2. LinkedIn redirects back to the callback with `?code=...&state=...` (the `code` is valid
     **30 minutes**, single use).
  3. Exchange it: `POST https://www.linkedin.com/oauth/v2/accessToken` (Content-Type
     `application/x-www-form-urlencoded`) with `grant_type=authorization_code`, `code`,
     `client_id`, `client_secret`, `redirect_uri`.
- **Access token lifetime: 60 days** (`expires_in: 5184000` seconds). LinkedIn does **not**
  issue long-lived access tokens.
- **Refresh token: 365 days.** Exchange it with
  `POST https://www.linkedin.com/oauth/v2/accessToken` + `grant_type=refresh_token` +
  `refresh_token` + `client_id` + `client_secret`. Each refresh mints a new **60-day** access
  token; the refresh token's clock keeps counting down from the original 365 days (it is *not*
  reset). After ~365 days the admin must re-authorize through the OAuth screen once.
- **⚠️ Refresh-token caveat (the main uncertainty):** LinkedIn's docs say *"LinkedIn supports
  programmatic refresh tokens for all approved **Marketing Developer Platform (MDP)** partners"*
  and *"Programmatic refresh tokens are available for a limited set of partners. If this
  feature has been enabled for your application…"*. The docs do **not** explicitly confirm that
  a **Community Management–only** app (no MDP/Ads) receives `refresh_token` in the token
  response. **Plan for both cases:**
  - **If refresh tokens ARE issued** (you'll see `refresh_token` + `refresh_token_expires_in`
    in the token JSON): the batcher refreshes silently; the admin re-auths ~once a year.
  - **If they are NOT** issued: you simply have a **60-day access token**. Because re-auth that
    is still-logged-in and still-valid bypasses the consent screen, the practical fix is a
    small monthly reminder for Jake to click "re-authorize" (a one-tap flow), or apply for MDP
    to unlock programmatic refresh. For ~1 post/day this is a minor operational chore, not a
    blocker. **Verify which case applies the first time you complete the OAuth exchange.**

---

## 7. Which steps need the human vs. can be pre-prepared

| Step | Who | Notes |
| --- | --- | --- |
| Be Super Admin of the MACPrep Page | **USER-ONLY** | Jake already is. |
| Use a macprep.org business email | **USER-ONLY** | Personal Gmail is rejected. |
| Create the developer app | **USER-ONLY** | LinkedIn login required. |
| Accept LinkedIn API Terms of Use | **USER-ONLY** | Legal acceptance. |
| Click the Page-verification ("Verify") link as Super Admin | **USER-ONLY** | Required gate. |
| Add redirect URL + copy Client ID/Secret | **USER-ONLY** | Then paste secret into Render env. |
| Request Community Management API + submit access form | **USER-ONLY** | Paste §4 copy. |
| Complete the OAuth authorization (click "Allow") | **USER-ONLY** | One-time consent (+ ~yearly re-auth). |
| Use-case description copy | **PREP-DONE** | §4 of this doc. |
| Legal name / address / website / privacy URL | **PREP-DONE** | §3 Phase A. |
| App name + logo assets | **PREP-DONE** | `MACPrep Page Publisher`, repo logos. |
| Redirect URL value | **PREP-DONE** | `https://www.macprep.org/auth/linkedin/callback`. |
| Org URN/`author` value | **PREP-DONE** | `urn:li:organization:130213953`. |
| Posting request body | **PREP-DONE** | §5. |
| Backend OAuth callback, token storage, `postToLinkedIn()`, batcher wiring | **PREP-DONE (design)** | §8 — code can be written now and lit up after approval. |

---

## 8. After approval: backend implementation outline

This fits the existing app: ESM (`src/server.mjs`), Express, Supabase via the service-role
`createClient`, env-driven config (see `.env.example`). No new heavy dependencies needed —
`fetch` is built into Node 18+.

### 8.1 New environment variables (add to `.env.example` and Render)
```
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_REDIRECT_URI=https://www.macprep.org/auth/linkedin/callback
LINKEDIN_ORG_URN=urn:li:organization:130213953
LINKEDIN_API_VERSION=202506
# Optional: protect the OAuth-connect route so only the admin can start it
LINKEDIN_CONNECT_SECRET=
```

### 8.2 Token storage in Supabase
Create a single-row table to hold the org token (service-role access only; never exposed to
clients). Encrypt at rest if possible.
```sql
create table if not exists linkedin_tokens (
  id              int primary key default 1,           -- single row
  access_token    text not null,
  refresh_token   text,                                -- may be null (see §6)
  access_expires  timestamptz not null,
  refresh_expires timestamptz,
  org_urn         text not null,
  updated_at      timestamptz not null default now()
);
-- RLS: no anon/auth access; only the service role (used by the server) reads/writes.
alter table linkedin_tokens enable row level security;
```

### 8.3 OAuth callback route (`src/server.mjs`)
```js
// --- LinkedIn OAuth: start (admin clicks once to connect the Page) ---------
app.get('/auth/linkedin/start', (req, res) => {
  // Optional: gate behind a secret so only Jake can initiate.
  if (process.env.LINKEDIN_CONNECT_SECRET &&
      req.query.k !== process.env.LINKEDIN_CONNECT_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const state = randomBytes(16).toString('hex');           // store in a short-lived cookie
  res.cookie?.('li_state', state, { httpOnly: true, secure: true, maxAge: 600000 });
  const scope = encodeURIComponent(
    'r_organization_social w_organization_social rw_organization_admin'
  );
  const url = 'https://www.linkedin.com/oauth/v2/authorization'
    + `?response_type=code&client_id=${process.env.LINKEDIN_CLIENT_ID}`
    + `&redirect_uri=${encodeURIComponent(process.env.LINKEDIN_REDIRECT_URI)}`
    + `&state=${state}&scope=${scope}`;
  res.redirect(url);
});

// --- LinkedIn OAuth: callback (exchange code -> tokens, persist) ------------
app.get('/auth/linkedin/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    // TODO: verify `state` matches the cookie set in /start (CSRF check).
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.LINKEDIN_CLIENT_ID,
      client_secret: process.env.LINKEDIN_CLIENT_SECRET,
      redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
    });
    const r = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const t = await r.json();               // { access_token, expires_in, refresh_token?, refresh_token_expires_in? }
    const now = Date.now();
    await supabase.from('linkedin_tokens').upsert({
      id: 1,
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? null,
      access_expires: new Date(now + t.expires_in * 1000).toISOString(),
      refresh_expires: t.refresh_token_expires_in
        ? new Date(now + t.refresh_token_expires_in * 1000).toISOString() : null,
      org_urn: process.env.LINKEDIN_ORG_URN,
      updated_at: new Date(now).toISOString(),
    });
    res.send('MACPrep LinkedIn Page connected. You can close this tab.');
  } catch (e) {
    Sentry.captureException?.(e);
    res.status(500).send('LinkedIn connect failed.');
  }
});
```

### 8.4 Token helper (refresh if possible, else surface that re-auth is needed)
```js
async function getLinkedInAccessToken() {
  const { data } = await supabase.from('linkedin_tokens').select('*').eq('id', 1).single();
  if (!data) throw new Error('LinkedIn not connected — run /auth/linkedin/start');
  const expiringSoon = new Date(data.access_expires).getTime() - Date.now() < 3 * 864e5; // <3 days
  if (!expiringSoon) return data.access_token;
  if (!data.refresh_token) {
    // No programmatic refresh token (see §6). Access token still valid; alert to re-auth.
    Sentry.captureMessage?.('LinkedIn access token expiring; admin must re-authorize.');
    return data.access_token;
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: data.refresh_token,
    client_id: process.env.LINKEDIN_CLIENT_ID,
    client_secret: process.env.LINKEDIN_CLIENT_SECRET,
  });
  const r = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const t = await r.json();
  const now = Date.now();
  await supabase.from('linkedin_tokens').update({
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? data.refresh_token,
    access_expires: new Date(now + t.expires_in * 1000).toISOString(),
    updated_at: new Date(now).toISOString(),
  }).eq('id', 1);
  return t.access_token;
}
```

### 8.5 `postToLinkedIn()` — publish a text + link share
```js
async function postToLinkedIn({ commentary, url, title, description }) {
  const token = await getLinkedInAccessToken();
  const payload = {
    author: process.env.LINKEDIN_ORG_URN,
    commentary,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
    // Include a real link preview card when title/description are provided:
    ...(url && title ? { content: { article: { source: url, title, description: description || '' } } } : {}),
  };
  const r = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'Linkedin-Version': process.env.LINKEDIN_API_VERSION || '202506',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (r.status !== 201) {
    const errText = await r.text();
    throw new Error(`LinkedIn post failed: ${r.status} ${errText}`);
  }
  return r.headers.get('x-restli-id');   // the new post URN
}
```

### 8.6 Wire into the weekly batcher
The current social workflow is hand-authored markdown (`marketing/social-posts/week-of-*.md`).
To automate:
1. Keep a queue of drafted posts — either a Supabase table `social_queue(id, commentary, url,
   title, description, scheduled_for, posted_at, post_urn)` or parse the weekly markdown into
   rows.
2. Add a scheduled job (Render Cron Job, or an internal `setInterval`/admin endpoint
   protected like the existing `/api/admin/*` routes) that runs daily, picks the next unposted
   item due, calls `postToLinkedIn(...)`, and writes back `posted_at` + `post_urn`.
3. On failure, capture to Sentry (already wired) and leave the row unposted to retry next run.
4. Idempotency: only post rows where `posted_at is null` and `scheduled_for <= now()`.

Minimal admin trigger (mirrors the existing `/api/admin/run-nudges` pattern):
```js
app.post('/api/admin/run-social-batcher', async (req, res) => {
  // reuse whatever admin guard /api/admin/* routes already use
  const { data: due } = await supabase.from('social_queue')
    .select('*').is('posted_at', null).lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true }).limit(1);
  if (!due?.length) return res.json({ posted: 0 });
  const item = due[0];
  const urn = await postToLinkedIn(item);
  await supabase.from('social_queue').update({ posted_at: new Date().toISOString(), post_urn: urn }).eq('id', item.id);
  res.json({ posted: 1, urn });
});
```

---

## 9. Facebook Graph API parallel (short — verified)

To post to the **MACPrep Facebook Page** programmatically:
- **Meta app** at <https://developers.facebook.com> + a **Page access token**, used against the
  Graph API (`POST https://graph.facebook.com/{page-id}/feed` with `message` and optional `link`).
- **Permissions:** `pages_manage_posts` (publish), plus its dependencies
  `pages_read_engagement` and `pages_show_list`.
- **Token:** exchange a short-lived **User** token → **long-lived User** token, then read the
  Page token from `/me/accounts`. A Page token derived from a **long-lived user token is
  effectively non-expiring** — nicer than LinkedIn's 60-day model.
- **App Review:** even for posting to **your own** Page, `pages_manage_posts` requires **App
  Review** (Advanced Access) and typically **Business Verification** of the legal entity.
  (You can develop/test with your own admin account in dev mode before review, but production
  posting needs the review.) So the Facebook path also has a manual approval gate, comparable
  in effort to LinkedIn's.

---

## 10. Blockers & uncertainties (read before applying)

1. **Programmatic refresh tokens for a Community-Management-only app (MEDIUM confidence).**
   The docs tie programmatic refresh tokens to **MDP partners** and "a limited set of
   partners." It's **not explicitly documented** that a Community-Management-only app gets a
   `refresh_token`. Mitigation built into §6/§8: the code handles both — refresh if present,
   otherwise rely on the 60-day token + a periodic one-tap re-auth. Confirm empirically on
   first token exchange.
2. **Org URN `130213953` (HIGH confidence it's correct, but verify).** The numeric ID in the
   Page URL is the org ID per LinkedIn docs, so `urn:li:organization:130213953` should be
   right. Confirm with the `GET /rest/organizations/130213953` call in §2 once you have a
   token. (A `403` there just means the token's member isn't a Page admin yet.)
3. **Commercial-use / business-email gate (HIGH confidence, action required).** Community
   Management is "for registered legal organizations, commercial use cases only," needs a
   **verified business email** (no personal Gmail) and a privacy policy. MACPrep LLC qualifies,
   but you **must apply with a macprep.org email**. If Jake only has a personal email on the
   LinkedIn account, set up `jake@macprep.org` first.
4. **Review timeline is approximate (~1–4 weeks).** This is a community-reported range, not an
   SLA in LinkedIn's docs. It can be faster or slower; rejection means a brand-new app + new
   request (you can't re-apply on the same app).
5. **`Linkedin-Version` will need occasional bumping.** Versions get sunset (the docs already
   show a deprecation notice for `202506` in some pages). Pin a recent version in
   `LINKEDIN_API_VERSION` and update it 2–3×/year.
6. **No public, fixed price** is associated with Community Management API access in the docs;
   it's a vetting/approval product, not a paid tier, for this first-party use case.

---

## Sources (official LinkedIn / Microsoft Learn, verified June 2026)

- Community Management — Overview: <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview>
- Community Management App Review (access process, tiers, screencast, page verification): <https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review>
- Posts API (endpoint, headers, permissions, text/article bodies, responses): <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api>
- Organization Lookup API (org URN/ID, `rw_organization_admin`): <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api>
- 3-legged OAuth flow (authorization + token exchange, 60-day access token): <https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow>
- Programmatic Refresh Tokens (365-day refresh, MDP-partner caveat): <https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens>
- Associate an app with a LinkedIn Page (verification link): <https://www.linkedin.com/help/linkedin/answer/a548360/associate-an-app-with-a-linkedin-page>
- Facebook Pages API / publishing permissions: <https://developers.facebook.com/docs/pages-api/> and <https://developers.facebook.com/docs/permissions/>

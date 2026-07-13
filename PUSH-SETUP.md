# Push Notifications — Setup Runbook

MACPrep has **two independent push channels**. They do not overlap, and each
reaches a different set of users:

| Channel | Reaches | Status | Blocked on |
| --- | --- | --- | --- |
| **Web Push (VAPID)** | Installed PWA (iOS 16.4+ home-screen, Android, desktop) + browsers | **Code-complete, dormant** | Two env vars (you) |
| **Native Push (APNs/FCM)** | App Store & Play Store native apps | **Not built** | Apple Developer + Firebase accounts (you) |

> **Why two?** The native apps are a Capacitor WebView shell that loads the live
> site. Web Push (the service-worker Push API) **does not fire inside a WebView**
> — so anyone who installs the *store app* gets nothing from Web Push. Store apps
> need the native APNs (Apple) / FCM (Android) path. The installed *PWA* uses Web
> Push. Most users are covered by one or the other.

---

## PART A — Turn on Web Push (do this now · ~10 min · no paid accounts)

Everything is already built: service-worker handlers, the subscribe/unsubscribe
flow, the `push_subscriptions` table, a daily reminder scheduler, and an admin
test trigger. It is all gated behind one flag: `PUSH_ENABLED = VAPID keys set`.

### A1. Generate a VAPID keypair

Run this on your own machine (keeps the private key off everyone else's):

```bash
npx web-push generate-vapid-keys
```

It prints a `Public Key:` and `Private Key:`. The **private key is a secret** —
never commit it, never paste it in chat or a ticket.

### A2. Set three env vars on Render

In the Render dashboard → your service → **Environment**:

```
VAPID_PUBLIC_KEY   = <the Public Key from A1>
VAPID_PRIVATE_KEY  = <the Private Key from A1>   ← secret
VAPID_SUBJECT      = mailto:support@macprep.org  (optional; this is the default)
```

Save → Render redeploys. On boot the log prints `[push] web-push configured`.
(Names are also documented in `.env.example`.)

### A3. Verify it went live

```bash
curl -s https://www.macprep.org/api/push/vapid-public
# before: {"enabled":false}
# after : {"enabled":true,"publicKey":"B..."}
```

Then, signed in, open **Profile** — the "Study reminders" card now appears
(it self-hides while `enabled:false`). Toggle it on → allow the browser prompt →
a row lands in `push_subscriptions`.

### A4. Send yourself a test push

As an admin (owner-email allowlist), from the browser console while signed in:

```js
fetch('/api/admin/run-nudges', {
  method:'POST',
  headers:{'Content-Type':'application/json','Authorization':'Bearer '+localStorage.macprep_token},
  body: JSON.stringify({ pushTest:true })
}).then(r=>r.json()).then(console.log)
```

You should get a notification within a second or two. That proves the entire
pipeline end-to-end.

> **After A2, tell me and I'll run the end-to-end verification with you** (confirm
> `enabled:true`, watch the subscribe row land, fire the test).

---

## PART B — Native Push for the store apps (needs your accounts)

This is the part that is genuinely blocked. **Do not install the push plugin
before Firebase is set up** — the Android build breaks without
`google-services.json`. Order matters; follow it top to bottom.

### B1. Apple side (iOS) — requires Apple Developer Program ($99/yr)

1. Enroll at <https://developer.apple.com/programs/> (business entity or individual).
2. **Certificates, Identifiers & Profiles → Identifiers →** register App ID
   `org.macprep.app` and check **Push Notifications**.
3. **Keys → +** → create an **APNs Auth Key**. Download the `.p8` (one download
   only). Record the **Key ID** and your **Team ID**.

### B2. Firebase side (Android + optionally iOS) — free

1. Create a Firebase project at <https://console.firebase.google.com/>.
2. Add an **Android app** with package name `org.macprep.app` → download
   **`google-services.json`** → place it at `mobile/android/app/google-services.json`
   (the Gradle plugin is already pre-wired to pick it up).
3. (If routing iOS through Firebase too — recommended, one send path for both):
   **Project settings → Cloud Messaging → Apple app config →** upload the APNs
   `.p8` from B1 with its Key ID + Team ID.
4. **Project settings → Service accounts →** generate a private key JSON (this is
   the server's send credential — a secret, stored as a Render env var, never
   committed).

### B3. Google Play — requires Play Console ($25 one-time)

Enroll at <https://play.google.com/console/> and reserve `org.macprep.app`
(permanent once submitted).

### B4. Then I wire the code (~20–30 min, all testable once B1–B2 exist)

Once the accounts + files above are in place, I will:

- `npm i @capacitor/push-notifications` in `mobile/`, `npx cap sync`.
- iOS: add the Push Notifications capability + `App.entitlements`
  (`aps-environment`), set the signing team, add APNs registration in
  `AppDelegate`.
- Android: `google-services.json` already dropped in → FCM lights up; add
  `POST_NOTIFICATIONS` handling for Android 13+.
- Web app: feature-detected native registration (`Capacitor.isNativePlatform()`)
  that grabs the native token and POSTs it to a new
  `POST /api/push/register-native` endpoint.
- Server: a `native_device_tokens` table + a Firebase Admin send path, gated by a
  `NATIVE_PUSH_ENABLED` flag exactly like the existing `PUSH_ENABLED` pattern.
- Test on a real device, then hand you the TestFlight / Play internal-testing steps.

> ⚠️ **App Store IAP caveat** (settle before submitting): Apple/Google generally
> require *their* in-app-purchase system for digital unlocks bought **inside** the
> app. Current plan keeps Stripe web-only and the apps merely unlock an account
> that was already purchased on the web. That's an allowed pattern but the app
> must not show a purchase/upgrade button that leads to Stripe — flag it in review.

---

## Notification policy (recommended defaults)

The audience is working clinicians — **frequency is the brand**. Over-notifying
is the #1 driver of mutes/uninstalls. Recommended posture:

- **Opt-in, default OFF.** (Already true — users flip the reminders toggle.)
- **≤ 1 push/day, ≤ 4/week per user.** Merge same-day candidates into one by
  priority: exam-countdown > spaced-review > streak > quest.
- **Quiet hours 9pm–8am.** (Current scheduler fires ~US-morning UTC — fine for a
  US audience; revisit per-user local time before scaling internationally.)
- **Professional tone**, one emoji max, no fake urgency or shame framing.

**Notification types, by value (build/enable in this order):**

1. **Spaced-review "N due"** — the retention backbone. *Already implemented* —
   goes live the moment Part A is on.
2. **Exam-countdown** (30/14/7 days out, keyed to `target_exam_date`) — highest
   trust-to-annoyance ratio.
3. **Streak-at-risk** (only for streaks ≥3, on no-activity days).
4. **Weekly progress recap** (Sunday) — feel-good, low risk.
5. **Daily-quest / QotD nudge** — gate it; never same day as #1 or #3.
6. **Re-engagement** for lapsed users (day 7/14/30, then stop).
7. **Premium/mock-exam** — prefer **in-app**, not push.

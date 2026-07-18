# Push Notifications — Setup Runbook

MACPrep has **two independent push channels**, each reaching a different set of users:

| Channel | Reaches | Status |
| --- | --- | --- |
| **Web Push (VAPID)** | Installed PWA (iOS 16.4+ home-screen, Android, desktop) + browsers | ✅ **LIVE** |
| **Native Push (APNs + FCM)** | App Store & Play Store native apps | 🔧 Code shipped (gated) — pending accounts + store resubmit |

> **Why two?** The native apps are a Capacitor WebView shell. Web Push does **not** fire inside a WebView, so store-app users need the native APNs (iOS) / FCM (Android) path. The installed PWA uses Web Push. Both coexist.

---

## PART A — Web Push ✅ DONE

VAPID keys are set on Render, `/api/push/vapid-public` returns `enabled:true`, and the full pipeline (service worker, subscribe flow, `sendPushReminders`, daily scheduler, admin test) is live for installed-PWA/browser users.

**To send yourself a test** (signed-in admin, browser console):
```js
fetch('/api/admin/run-nudges',{method:'POST',
  credentials:'same-origin',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({pushTest:true})}).then(r=>r.json()).then(console.log)
// → { ok:true, web_test_sent:N, native_test_sent:M }
```

---

## PART B — Native Push (store apps)

**Architecture: SPLIT** (chosen after a research + adversarial-verify pass — the SPM-only iOS project can't cleanly take Firebase's iOS SDK):

- **iOS** → `@capacitor/push-notifications` → raw **APNs** token → server sends via the **`.p8`** (`@parse/node-apn`). **iOS never touches Firebase.**
- **Android** → same plugin → **FCM** token → server sends via **`firebase-admin`**.
- One client plugin, two server send paths keyed off `native_device_tokens.platform`. All server/client code is **shipped and gated** — dormant until the env vars below are set.

### B1. Firebase — Android only (Jake)
1. Create the Firebase project (Analytics off is fine).
2. Add an **Android** app, package `org.macprep.app` → download **`google-services.json`** → place at `mobile/android/app/google-services.json`.
3. **Project settings → Service accounts → Generate new private key** → save the JSON (secret).
4. **Do NOT** add an iOS app or upload the `.p8` to Firebase — iOS uses APNs directly.

### B2. Apple (Jake) — already done
App ID `org.macprep.app` has Push enabled; APNs key `628C32F7L4` created; Team `KHDCN5PKGG`. The `.p8` goes to **Render** (below), not Firebase. In Xcode (Claude will drive): sign with Team `KHDCN5PKGG`, add Push Notifications + Background Modes → Remote notifications.

### B3. Render env vars (Jake — Environment tab, then redeploy)
```
FIREBASE_SERVICE_ACCOUNT = <the full service-account JSON, minified to one line>   # Android FCM
APNS_KEY_P8              = <full .p8 contents incl. the -----BEGIN/END PRIVATE KEY----- lines>
APNS_KEY_ID             = 628C32F7L4
APPLE_TEAM_ID           = KHDCN5PKGG
APNS_BUNDLE_ID          = org.macprep.app
APNS_PRODUCTION         = true      # use "false" while testing a dev build from Xcode; "true" for TestFlight/App Store
```
Setting these flips `NATIVE_PUSH_ENABLED` on (mirrors the VAPID gate). `firebase-admin` is currently pinned to the v14 major; use the Node version declared by the project and verify the Render build before enabling delivery.

### B4. Native wiring (implemented; validate once B1 files exist)
- `@capacitor/push-notifications`, APNs token forwarding in `AppDelegate.swift`, native-device token registration, and server-side APNs/FCM delivery are implemented.
- Android's `POST_NOTIFICATIONS` permission is merged by the plugin.
- Rebuild the native apps after adding Firebase configuration, then perform a real-device reminder and push-delivery test before TestFlight / Play internal testing.

### Gotchas (baked into the code / to remember)
- **APNs sandbox vs production:** an Xcode-run dev build gets a *sandbox* token that fails against `APNS_PRODUCTION=true` with `BadDeviceToken`. Set `APNS_PRODUCTION=false` for dev testing, `true` for store builds.
- **Android is silent until `google-services.json` is present** and the app is rebuilt (build stays green without it — guarded apply block).
- **Native needs a store resubmit** — unlike Web Push, Capacitor OTA doesn't cover new native plugins/capabilities. The server + app.js half is already deployed; native *tokens* only flow after users update the store builds.
- **Store payments:** blocking Stripe in the native shell is required, but it does not itself establish approval eligibility for paid digital study content. Complete the selected store-billing or approved-program path before submission; see `STORE-SUBMISSION.md`.

---

## Notification policy (recommended defaults)

Working-clinician audience — **frequency is the brand.** Opt-in, default OFF (already true). ≤1 push/day, ≤4/week/user; quiet hours 9pm–8am; professional tone. Types by value: (1) spaced-review "N due" *(live)*, (2) exam-countdown, (3) streak-at-risk, (4) weekly recap, (5) daily-quest/QotD, (6) re-engagement (day 7/14/30 then stop), (7) premium — prefer in-app.

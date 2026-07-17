# MACPrep — native iOS & Android apps (Capacitor)

This folder is a thin **native shell** that loads the live MACPrep web app
(`https://www.macprep.org`). Because both apps run the *same* web codebase, **every
web deploy automatically updates the phone apps** on next launch — no re-porting, no
store resubmission for web/content/feature changes.

> **Web changes** (features, copy, styling, new modes) → land on the apps automatically.
> **Native changes** (app icon, splash, adding a native plugin, OS permissions) → need
> a new build submitted to the App Store / Play Store (review: ~1 day iOS, hours Android).

- **App name:** MACPrep
- **Bundle / app ID:** `org.macprep.app` — change this in `capacitor.config.json` **before**
  creating the App Store / Play listings (it's permanent once submitted).
- **Loads:** `https://www.macprep.org` (see `capacitor.config.json` → `server.url`).

## One-time setup

**iOS** (Xcode 26 already installed — **no CocoaPods needed**; Capacitor 8 uses Swift Package Manager):
1. From this folder: `npm install` (already done once) then `npx cap sync ios`.
2. `npx cap open ios` → Xcode resolves the Swift packages automatically → pick a simulator or your iPhone → press ▶.
3. To run on your **own iPhone**, set a Signing Team in Xcode → *Signing & Capabilities* (your free Apple ID works for on-device testing; the $99 Developer Program is only needed to ship to the App Store).

**Android:**
1. Install **Android Studio** (includes the SDK): https://developer.android.com/studio
2. From this folder: `npm install && npx cap sync android`.
3. `npx cap open android` → pick an emulator or device → press ▶.

## Everyday commands
- `npx cap sync` — re-sync config/plugins to the native projects (run after changing
  `capacitor.config.json` or adding a plugin).
- `npx cap open ios` / `npx cap open android` — open the native project to build/run.

## App icon + splash — ✅ DONE
Generated from the brand pulse-tile mark. Sources in `assets-src/*.svg` → rendered to
`assets/*.png` → `npx @capacitor/assets generate`. To change the mark later: edit
`assets-src/`, re-render (`rsvg-convert -w 1024 -h 1024 assets-src/icon-only.svg -o assets/icon-only.png`, etc.),
then re-run `npx @capacitor/assets generate` and `npx cap sync`.

## Push notifications — code complete, credentials still required
`@capacitor/push-notifications`, native token registration, and the server's APNs/FCM
delivery paths are already implemented. Delivery remains gated until credentials are set:
- **iOS:** Apple Developer account, enabled Push Notifications capability, and an APNs auth
  key (`.p8`) configured on Render.
- **Android:** Firebase project, `android/app/google-services.json` (kept ignored), and the
  Firebase service-account JSON configured on Render.

The Android Gradle build intentionally stays buildable without `google-services.json`; push
delivery becomes available only after the Firebase file is present and the app is rebuilt.

## Then
1. **Developer accounts** — Apple Developer ($99/yr), Google Play ($25 once). Start Apple early.
2. **Create the matching store products** — `org.macprep.app.full_access`, a one-time non-consumable on Apple and one-time managed product on Google Play. Set the initial US price to $99.99 (marketed as $100 lifetime access).
3. **Deploy the server migration and credentials** — apply `supabase/migrations/20260717225318_mobile_purchase_entitlements.sql`, then set the native-purchase environment variables from `.env.example` in Render.
4. **Test on real devices** — verify sign-in, study flow, a sandbox purchase, restore purchases, web-to-app access, and opt-in reminders.
5. **TestFlight / Play internal testing** → store submission. For iOS, archive with an Xcode
   account that can access `org.macprep.app`; `ios/App/ExportOptions-AppStore.plist` supplies
   the App Store Connect export settings.

## Payments note
The native bridge uses each store's billing system for its one-time full-access product.
StoreKit 2 and Google Play Billing return a transaction token to the server; the server
validates it directly with Apple or Google, records it once in the server-only
`mobile_purchase_entitlements` ledger, then grants the usual account-level premium tier.
The app never trusts a client-side payment result.

This preserves cross-save: web buyers, vouchers, and program-granted accounts have premium
on the same signed-in app account without another charge; a verified store purchase unlocks
that same account on the web. The native app must never open Stripe, a web checkout, or a
class/cohort-code redemption path. The Store price is loaded from Apple/Google instead of
being hard-coded in the app.

Before testing a purchase, create `org.macprep.app.full_access` in both stores and configure
the production server credentials listed in `.env.example`. Do not transfer a verified store
purchase between different MACPrep accounts; use the account that was signed in at purchase
time and the native Restore purchases action for recovery.

## Android release signing
The release build supports a local Android keystore without committing secrets. Create the
keystore, then add `android/keystore.properties` using
`android/keystore.properties.example` as the field reference. When all four properties are
present, `./gradlew :app:bundleRelease` signs the resulting `.aab`; without them it remains
unsigned and cannot be uploaded to Play.

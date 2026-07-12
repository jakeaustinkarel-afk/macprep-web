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

## Roadmap (next, in order)
1. **Native push notifications** (`@capacitor/push-notifications`) — real APNs/FCM; fixes
   iOS web-push limits. (This is a *native change* → needs a store build.)
2. **App icon + splash screen** (`@capacitor/assets`) from the brand mark.
3. **Native polish**: safe-area insets, theme-aware status bar, Android back button.
4. **Developer accounts**: Apple Developer ($99/yr), Google Play ($25 once).
5. **TestFlight / Play internal testing** → store submission.

## Payments note
Apple/Google generally require their in-app-purchase system (15–30%) for digital
unlocks bought *inside* the app. Current plan: apps are free-to-use and **unlock
accounts that already purchased the $50 on the web** (Stripe stays web-only). Revisit
if mobile conversion matters. Decide before store submission.

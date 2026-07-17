# MACPrep — App Store + Play Store Submission Kit

Everything paste-ready for both stores. **Bold = a decision or action that's yours.**
Bundle / App ID: **`org.macprep.app`** · Version **1.0** · Build **1** · Category **Education**.

---

## 0. Readiness gate (do before submitting)

| Item | Status |
| --- | --- |
| iOS build + native push verified on a real device | **validate before submission** |
| Native IAP source integration | ✅ implemented; create products, deploy the ledger migration and configure credentials before testing |
| Native-feel polish (safe areas, status bar, links, no PWA banner or web-commerce UI in-app) | ✅ implemented; validate on devices |
| Store listings + metadata | ✅ below |
| Screenshots | **you capture — see §4** |
| Reviewer demo account | **you create — see §3.7** |
| Privacy policy URL | ✅ https://www.macprep.org/privacy.html |
| Support URL | **pick one — see §2** |

---

## 1. In-app purchase compliance (the #1 rejection risk)

MACPrep implements the store-billing release path. Create the following matching products before testing or submission:

| Store | Product ID | Type | Initial US price |
| --- | --- | --- | --- |
| App Store Connect | `org.macprep.app.full_access` | Non-consumable in-app purchase | $99.99 |
| Play Console | `org.macprep.app.full_access` | One-time managed product | $99.99 |

The app loads localized price text from the store. On a completed purchase, the device sends
only the Apple transaction ID or Google Play purchase token to `POST /api/mobile-purchases/verify`.
The server verifies it directly with the relevant store, checks the product, app, purchase
state, and bound MACPrep account, writes a replay-protected server-only ledger entry, then sets
`user_profiles.account_tier='premium'`. A browser-initiated Stripe purchase, voucher, or
program grant uses that same account entitlement, so it unlocks the apps without a second
charge. A completed store purchase unlocks the web when the learner signs into the same account.

Before enabling the purchase button, deploy
`supabase/migrations/20260717225318_mobile_purchase_entitlements.sql` and configure the Apple
and Google credentials documented in `.env.example` on Render. Test an Apple Sandbox purchase
in TestFlight and a Google license-test purchase in Play Internal testing. The native restore
action revalidates an owned purchase; do not transfer a store purchase to another MACPrep
account.

The web/PWA keeps Stripe checkout and class/cohort-code redemption. The native shell must never
route a user to Stripe, web checkout, or a code-based unlock.

---

## 2. Shared identity & URLs

- **App name (Apple, ≤30):** `MACPrep`
- **Subtitle (Apple, ≤30):** `NCCAA board review for CAAs`
- **Promotional text (Apple, ≤170, editable anytime):** `Board-ready question bank for Certified Anesthesiologist Assistants and students — clinician-reviewed, fully sourced, with mock exams, flashcards, and spaced-repetition review.`
- **Privacy Policy URL:** `https://www.macprep.org/privacy.html`
- **Support URL:** **pick one** — recommend a simple `https://www.macprep.org/faq.html` or `https://www.macprep.org/#contact`, or set `support@macprep.org` as the support contact. Apple requires a reachable support URL.
- **Marketing URL (optional):** `https://www.macprep.org`
- **Copyright:** `2026 MACPrep LLC`
- **Primary category:** Education · **Secondary:** Medical

---

## 3. Apple — App Store Connect

### 3.1 Description (paste into "Description")
```
MACPrep is the board-review question bank built specifically for Certified Anesthesiologist Assistants (CAAs) and student anesthesiologist assistants (SAAs) preparing for the NCCAA certifying and recertifying exams.

Every question is written and reviewed by a practicing CAA, mapped to the six official NCCAA content domains, and backed by a cited source — so you always know why an answer is right.

WHAT'S INSIDE
• A growing bank of board-level questions with detailed explanations and a rationale for every answer choice
• Full-length Mock Exam — 180 questions in 220 minutes, the exact length and timing of the real NCCAA exam, with a per-domain score report
• Spaced-repetition review that resurfaces questions right before you'd forget them
• A Recommended set that adapts to your ability in each domain
• Build-your-own flashcard decks with active recall
• Critical Events — rapid-reference cards for major anesthesia crises, cross-checked against the Stanford Emergency Manual
• Progress tracking: mastery by domain, streaks, and readiness

BUILT FOR HOW YOU STUDY
Study in focused sets by specialty, drill your missed questions, or take a quick daily question. Turn on study reminders to get nudged when your reviews are due.

FREE TO START
Practice every day for free. Full access unlocks the complete bank, mock exams, flashcards, and more.

MACPrep is made by a practicing CAA — built to be the study tool we wished we'd had.

Questions or feedback? support@macprep.org
```

### 3.2 Keywords (paste into "Keywords", ≤100 chars, comma-separated, no spaces)
```
CAA,SAA,NCCAA,anesthesia,anesthesiologist,assistant,board,exam,qbank,questions,review,certification,CME
```

### 3.3 What's New (version 1.0 release notes)
```
Welcome to MACPrep on iPhone. The full board-review bank, mock exams, flashcards, Critical Events, and study reminders — now on your home screen.
```

### 3.4 Age rating answers
- Medical/Treatment Information: **Infrequent/Mild** → results in **12+** (acceptable). *(If asked, the app contains clinical exam content, no diagnosis/treatment advice for the user's own care.)*
- All other categories: None.
- Made for Kids: **No**.

### 3.5 App Privacy ("data collection" questionnaire) — answers
Collected, **linked to identity**, for **App Functionality** (not tracking, not ads):
- **Contact Info** → Email address, Name
- **User Content** → none beyond in-app feedback (anonymous)
- **Identifiers** → User ID (account)
- **Usage Data** → Product Interaction (study activity/progress)
- **Diagnostics** → Crash Data (Sentry), if enabled

Answers to the toggles:
- Do you or your partners use data for **tracking**? **No**
- Data used for **third-party advertising**? **No**
- Is data **linked to the user**? **Yes** (tied to their account)
- **Encryption in transit**: Yes (HTTPS)
- Account deletion available: **Yes** (Account → Delete account)

### 3.6 Encryption / export compliance
- **ITSAppUsesNonExemptEncryption = NO** is set in `mobile/ios/App/App/Info.plist` because the app uses standard HTTPS only.

### 3.7 App Review notes (paste into "Notes") — **critical, include a demo account**
```
MACPrep is a board-exam study app for Certified Anesthesiologist Assistants. Most content is behind a login.

DEMO ACCOUNT (full access enabled for review):
  Email: <you create this — a real account with premium unlocked>
  Password: <...>

Notes:
- The app is a native iOS app (Capacitor) that also delivers native push notifications ("Study reminders" under Profile → Enable reminders).
- `org.macprep.app.full_access` is a one-time non-consumable in-app purchase that unlocks complete board-review access for the signed-in MACPrep account. The native upgrade sheet includes Restore purchases.
- Web-purchased, voucher, and program-granted premium accounts unlock here automatically after sign-in. The app never links to external checkout.
- Content is professional exam-prep material; no user-directed medical advice.
Contact: support@macprep.org
```
> **Action:** create a review demo account and drop its credentials here before you submit — reviewers will reject a login-walled app without one.

### 3.8 Build / TestFlight
- Xcode → Product → **Archive** (Release) → Distribute → App Store Connect → Upload.
- The repository includes `mobile/ios/App/ExportOptions-AppStore.plist` for a repeatable
  App Store Connect export. The Mac running the export must be signed in to an App Store
  Connect account with access to `org.macprep.app` so Xcode can obtain the distribution profile.
- The build config selects **development** APNs for Debug and **production** APNs for Release. Set **`APNS_PRODUCTION=true`** on Render before TestFlight/App Store push testing.
- Optional but recommended: enable **TestFlight** and install on your own phone first.

---

## 4. Screenshots (you capture; I'll tell you exactly what)

Apple requires **6.9" iPhone** screenshots (1320×2868) — you can capture on your device or the iPhone 16 Pro Max simulator. **3–5 great ones**, in this order:
1. **Dashboard** — level, streak, mastery-by-domain (the "serious progress" shot)
2. **A question with its explanation** — the core value, shows sourcing
3. **Mock Exam** setup or score report (180q / per-domain)
4. **Critical Events** card (premium depth)
5. **Study Modes** grid (breadth: flashcards, duel, arcade, search)

Play needs **phone screenshots** (min 2; 1080×1920 or similar) — reuse the same shots. Also Play requires a **Feature Graphic 1024×500** (I can spec/generate this).

> Tip: capture on a clean account with a few days of activity so the dashboard looks alive.

---

## 5. Google Play Console

- **App name (≤30):** `MACPrep`
- **Short description (≤80):** `NCCAA board review for Certified Anesthesiologist Assistants & students.`
- **Full description (≤4000):** reuse §3.1 (Play allows the same copy).
- **Category:** Education · **Tags:** education, medical
- **Content rating:** complete the IARC questionnaire → references to medical/educational content, **no** violence/sex/gambling → expect **Everyone / PEGI 3**.
- **Data safety form** (mirror §3.5): collects Email, Name, User ID, App activity; purpose App functionality + Account management; **encrypted in transit**; **no** data sold/shared; users **can request deletion** (support@macprep.org / in-app).
- **Target audience:** 18+ (professional/clinical) — avoids the "designed for families" flow.
- **Pricing:** Free · **Countries:** your choice (US at minimum).
- **Build:** configure the ignored `mobile/android/keystore.properties` (see `mobile/android/keystore.properties.example`), then generate a signed **App Bundle (.aab)** → upload to an **Internal testing** track first, then promote to Production.

---

## 6. Submission runbook (order of operations)

**iOS**
1. Create the non-consumable product in §1, then make its TestFlight Sandbox configuration available for the build.
2. Apply the mobile-purchase Supabase migration and configure the Apple IAP verification variables on Render.
3. Set `APNS_PRODUCTION=true` on Render.
4. App Store Connect → **My Apps → +** → New App → pick bundle `org.macprep.app`, name **MACPrep**, language English (U.S.).
5. Fill Description/Keywords/URLs/Category from §2–§3, upload screenshots (§4).
6. App Privacy (§3.5), Age rating (§3.4), Review notes + **demo account** (§3.7).
7. Archive → upload build → TestFlight on a real device: complete a Sandbox purchase, restore it, verify web-to-app and app-to-web entitlement sync, then select the build in App Store Connect.
8. **Submit for Review.** (Apple: ~1–3 days.)

**Android**
1. Create the managed product in §1 and grant Android Publisher API access to the service account used on Render.
2. Apply the mobile-purchase Supabase migration and configure the Google Play verification variable on Render.
3. Play Console → **Create app** → MACPrep, Education, Free, accept declarations.
4. Store listing (§5) + screenshots + feature graphic.
5. Content rating, Data safety, Target audience, App access (give the **demo account** here too).
6. Upload the `.aab` to Internal testing, verify a license-test purchase and restore, then **promote to Production → submit.**

---

## 7. Gotchas already handled / to remember
- **Guideline 4.2 (minimum functionality):** native push + full study feature set + offline install = well past a "thin web wrapper." The review notes lead with the native push.
- **`APNS_PRODUCTION`**: `false` for Xcode dev builds (sandbox), **`true`** for the store build. Don't forget to flip it.
- **Demo account is mandatory** for both stores (login-walled app).
- **Do not submit before the server can verify purchases.** The UI alone is not enough: create the matching store product, deploy the ledger migration, set server credentials, and complete the real-device purchase/restore checks first.

# MACPrep Analytics

MACPrep uses self-hosted, low-PII product analytics in Supabase. The client sends
an allowlisted event name and a small metadata object to `POST /api/event`; the
server records an optional account ID, event name, timestamp, and bounded metadata.
No device identifier, advertising identifier, IP address, email address, question
answer, or free-form user text belongs in analytics metadata.

## Platform Attribution

Every browser event carries one of these `meta.platform` values:

- `web`
- `ios`
- `android`

The Capacitor shell loads the same web application as the public site. This means
one authenticated account can be counted separately by platform without creating
another identity. Historical events without the field appear as `untagged` in
Founder Metrics rather than being guessed as web usage.

## Product Events

Core account and funnel events: `page_view`, `signup`, `login`, `session_start`,
`session_complete`, `paywall_hit`, `checkout_started`, `upgrade_click`,
`upgrade_success`, and server-recorded `purchase`.

Native lifecycle events: `app_open` on a cold launch and `app_foreground` when a
native app returns from the background.

Feature-adoption events: `recommended_start`, `diagnostic_start`,
`specialty_quiz_start`, `mock_exam_start`, `flashcards_start`,
`critical_events_open`, `arcade_start`, and `boss_start`.

## Reporting Boundaries

Founder Metrics is the source of truth for authenticated product activity and
cross-platform feature use. It does not replace App Store Connect analytics:
Apple remains the source of truth for App Store installs, Apple-reported sessions,
retention, and StoreKit sales/proceeds. Stripe remains the source of truth for web
purchase revenue. Store purchase events are recorded internally for funnel and
entitlement reconciliation, but Apple proceeds are not added to Stripe revenue.

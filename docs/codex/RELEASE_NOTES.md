# MACPrep Release Notes Workflow

Every production MACPrep product release needs a matching entry in both user-facing update surfaces before deployment:

1. In-app: add the release at the top of `WHATS_NEW` in `src/app.js` and increment `WHATS_NEW_VERSION`.
2. Public: add the matching newest-first entry to `updates.html`.
3. Validation: run `node --check src/app.js`, `npm test`, and `git diff --check` before deploying.

## Writing Rules

- Lead with the user outcome, not an implementation detail.
- Include the date, a short title, and one to three concrete points.
- Use the same title and date in both surfaces. The test suite verifies that the newest in-app title appears in the public log.
- Say where the change is available: web, current mobile shell, or a future iOS/Android build.
- Never say a native App Store or Play Store build is live until that build is available to users.
- Describe security and reliability work in user-safe language. Do not reveal secrets, exploit paths, account identifiers, or defensive controls.
- Group related work released together into one understandable note. Every production product release is still logged; a batch is not a reason to omit a change.

## Release Entry Template

```text
Tag: New | Improved | Fix
Date: Mon DD
Title: Short, user-centered outcome
Description: What changed, where it is available, and any action the user needs to take.
```

Use `WHATS_NEW_VERSION` as the release-notification version. New users are silently initialized to the current version; returning users see the popup once per version and can always reopen the complete in-app list from **What's New**.

# State-Academy Partnerships — Member-Benefit Campaign

Goal: partner with every US state academy of Anesthesiologist Assistants (FAAA, GAAA, etc.) to offer
MACPrep as an **exclusive member discount** — helping the academy drive/retain membership, and putting
MACPrep in front of that state's CAAs + SAAs.

**Competitive urgency (2026-07-01):** Vigilant IQ just landed a **20% FAAA member benefit** ("NCCAA Exam
Prep & CME for CAAs"). Get ahead of them across the *other* state academies before they lock the channel.

## The wedge — out-value, don't out-discount
20% vs 20% is a marginal race to the bottom. The real weapon is the **economics**:
- **MACPrep = $50 ONE-TIME, lifetime, no subscription.** A 20% member discount → **~$40 for life.**
- Vigilant is a **subscription** (~$99–$299); 20% off is still recurring. So MACPrep's member value is
  *categorically* better, not slightly better.
- Also lead with **research-cited transparency** + **built by a practicing CAA**. NEVER knock Vigilant.

## The offer to academies
- **Exclusive 20% member discount** via a **unique per-academy code** (e.g. `GAAA20`) → lifetime ~$40.
  Unique codes make each academy's redemptions **trackable** — they see the benefit getting used, and we
  can measure which partnerships convert. Same idea as the cohort/classmate codes, just per-organization.
- **Code mechanism (DEV-THREAD setup):** each academy needs its own 20%-off code (e.g. `FAAA20`), trackable.
  Decide whether to extend the existing voucher system (`program_vouchers`) to support a percentage
  discount, or use Stripe percentage promo codes at checkout. Marketing-side, the pitch just says "your
  academy's member code."
- Framed as a **member benefit that helps them recruit + retain** — the academy's #1 goal.
- **Zero cost, zero work:** MACPrep supplies the code + a co-promo graphic; the academy just shares it.
- **Reciprocal:** MACPrep cross-promotes the academy to its users (drives membership applications).
- Even where an academy already has Vigilant (FAAA), MACPrep is a **complementary/alternative** benefit —
  members like options, and the price point is unbeatable.

## Coverage conclusion (verified 2026-07-01)
Per ASA, CAAs are licensed in only **24 jurisdictions** (AL, CO, DC, FL, GA, IN, KS, KY, MI, MO, NV, NM,
NC, OH, OK, PA, SC, TN, TX, UT, VT, VA, WA, WI + Guam). So:
- **The ~26 AAAA-listed academies + AR/MD/UT are the full reachable universe.** `contacts.csv` covers them.
- **The non-listed ("not underlined") states are mostly DEAD ENDS:** CA, LA, ME, MS, MT, NE, NH, NY don't
  license CAAs → no real academy to contact. Only **Alabama** (licensed, but no findable academy/contact)
  and **Kentucky** (licensed, but no academy — CAAs route through the KY Society of Anesthesiologists) are
  exceptions, and neither has an actionable contact. **Nothing to email there.**
- **The ~14 form-only academies have no public email** — reach them via their **contact form** (URLs in the
  CSV) or their **named president** (e.g. TX = Alan Rivera, AZ = Tiffany Cothren, IN = Elizabeth Rivera,
  WA = Sarah Brown). Arkansas = pre-licensure advocacy, contested (HB 1205), bot-blocked — skip for now.

## Files
- `pitch.md` — outreach email + member-benefit terms + co-promo graphic spec.
- `contacts.csv` — **VERIFIED roster of ~29 state academies + contacts (compiled 2026-07-01).** ~12 have a
  direct email; the rest are contact-form / DM. **KEY FINDING: the channel is 100% GREENFIELD** — no academy
  publicly advertises any exam-prep/CME partner discount (no incumbent to displace). **WARM-IN:** Kris Tindol
  is GAAA's liaison → do Georgia first. The FAAA×Vigilant 20% (per Jake's screenshot) isn't on FAAA's public
  site — confirm scope before assuming FL is taken. Timing plays: TN + VA (newly licensed 2025, mobilizing).

## How to run
1. Fill in contacts (verified list incoming). 2. Send the pitch to each academy's board/info contact.
3. On a yes → generate an academy-coded 20% discount + a co-branded graphic. 4. Track replies.
Ties to [[project-partnerships]] and the competitor brief `marketing/competitive-vigilant-iq.md`.

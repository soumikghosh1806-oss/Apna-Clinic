# Cliniq

Clinic queue management and patient records for small clinics. Patients find a clinic on the home page (or use its own link), book a token on their phone and follow the live queue, reception runs the day's list, the doctor calls the next patient and writes notes and prescriptions, a waiting room display shows the queue, and the owner sees reports, sets each doctor's timetable and adds staff. In real mode the product is called **Apna Clinic**; demo mode keeps the original name Cliniq.

Cliniq runs in two modes, chosen by `VITE_BACKEND`:

| Mode | What it is | Use it for |
| --- | --- | --- |
| `demo` (default) | The original 12 screens with invented data kept in the browser. No server, no real login. | Trying the screens, design review, the original test suite. |
| `supabase` | The same 12 screens on a real backend: Postgres, Auth, Storage and Realtime on Supabase, with row level security. | A real clinic, after the checks in "Before real patients" below. |

Demo mode is kept on purpose until the real backend has been tested on your own project.

## Install and run

Needs Node.js 22.12 or newer.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type check, production build, and a scan that fails if a secret key is in the site
npm run preview    # serve the production build, http://localhost:4173
npm test           # 254 unit tests
```

With no `.env.local` the app starts in demo mode. This copy ships a `.env.local` that selects the real backend on your project (`VITE_BACKEND=supabase`). To see demo mode, change that line to `VITE_BACKEND=demo`, or start with `VITE_BACKEND=demo npm run dev`. The unit tests always use demo settings, whatever `.env.local` says.

### Try everything locally, without a Supabase account

The test stand-in can also be used by hand. It runs the real SQL from `supabase/migrations` and the real code of both Edge Functions on a throwaway database, so **everything in the app works, including staff accounts, timetables, the home page directory and codes**. Nothing is sent anywhere: the text messages and emails go to a local list that you read yourself. Data is lost when you stop it.

```bash
# terminal 1 (needs Node 22.12+; run as a normal user, not root)
cd supabase/tests && npm install && cd e2e && node api-shim.mjs

# terminal 2, in the project folder
VITE_BACKEND=supabase VITE_SUPABASE_URL=http://127.0.0.1:54399 \
  VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_localshim_000000000000000000 npm run dev
```

Open http://localhost:5173. Register a clinic at `/register`. To read the codes and emails the app "sends": http://127.0.0.1:54399/__shim/sms (text messages, the 6 digit code is in the text) and http://127.0.0.1:54399/__shim/outbox (emails). To see how a failure looks, use the controls `POST /__shim/sms-mode` and `POST /__shim/email-mode` (the browser tests show how). This is for trying the product, not a production setup. The real project has no such shortcut: codes arrive only by real SMS or email.

The stand-in listens on this computer only (127.0.0.1) and has a raw SQL test endpoint, so never expose it to a network. To try the app on a real phone, use your real Supabase project (below) with the app served over your network or deployed.

## The 12 screens

| # | Screen | Route | Who |
| --- | --- | --- | --- |
| 1 | Token booking | `/c/<clinic>/book` | Patient |
| 2 | Token confirmation | `/c/<clinic>/token/:key` | Patient |
| 3 | Live queue | `/c/<clinic>/queue` | Patient |
| 4 | Today's list | `/reception` | Receptionist |
| 5 | Walk-in entry | `/reception/walk-in` | Receptionist |
| 6 | Patient search | `/reception/patients` | Receptionist |
| 7 | Next patient | `/doctor` | Doctor |
| 8 | Patient history, notes, prescriptions, reports | `/doctor/history/:patientId` | Doctor |
| 9 | Waiting room display | `/c/<clinic>/tv` | Anyone (open on the clinic TV) |
| 10 | Daily report | `/report` | Owner, doctor |
| 11 | Settings, doctors, staff logins, public links | `/settings` | Owner |
| 12 | Staff login | `/login` | Staff |

In demo mode the patient pages are `/book`, `/token/:id`, `/queue` and `/tv`, as before.

New with the real backend: `/` is the public home page with **Book Your Doctor Appointment**, a search over clinics that chose to be listed (screen 1 and 3 are reached from it, or from a clinic's own link); `/register` (create an owner account and a clinic); and `/set-password` (where password reset emails lead, and where a new staff member is sent to choose a private password at first sign in). Every clinic gets its own address, `/c/<clinic>`, for its patient pages. A patient's token page and personal queue view use a private key in the link: `/c/<clinic>/token/<key>`.

## Environment variables

Only three, all read by the browser, so all of them are public. The app and the build both refuse a secret key.

| Variable | Value |
| --- | --- |
| `VITE_BACKEND` | `demo` or `supabase` |
| `VITE_SUPABASE_URL` | The project URL, for example `https://gdcvtjdvmaivfafltqfq.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The publishable key (`sb_publishable_...`) or the older anon key |

Never put a `sb_secret_...` or `service_role` key in any `VITE_` variable. Vite copies those into the public website. The Edge Functions get the project keys from Supabase automatically.

### Secrets for the Edge Functions (set in the Supabase dashboard or with `supabase secrets set`, never in the website)

| Secret | Needed for | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | Every app email | A sending key from your provider. Without it the app says "Email is not set up" and sends nothing. |
| `EMAIL_FROM` | Every app email | `Apna Clinic <no-reply@mail.yourdomain.com>`. The domain must be verified with the provider. |
| `APP_BASE_URL` | Links inside emails | Your production address, `https://yourdomain.com`, no slash at the end. |
| `OTP_HASH_SECRET` | Patient codes | 32 or more random characters. `openssl rand -base64 48`. |
| `EMAIL_REPLY_TO`, `SUPPORT_EMAIL` | Optional | A mailbox you read. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM` | Text message codes | Optional. Without them the email way of getting a code still works. India needs DLT registration, see `docs/EMAIL_SETUP.md` step 6b. |

Full explanation, with provider steps, DNS records and troubleshooting: **`docs/EMAIL_SETUP.md`**.

`.env.local` is git-ignored. The copy shipped with this project holds only the project URL and the publishable key.

## Supabase project setup

Migrations 1 to 6 are applied to project `gdcvtjdvmaivfafltqfq`. Migrations 7, 8 and 9 (staff accounts, doctor timetables, the public directory and codes) are written and tested but **are applied to a project only when you apply them** (see Deploying). To set up a different project, apply every file in `supabase/migrations/` in order, then deploy the Edge Functions listed below.

| Migration | What it does |
| --- | --- |
| `20261106000001_cliniq_schema_additions` | Adds the 13th table (`audit_log`), columns, constraints, indexes, the new-user profile trigger |
| `20261106000002_cliniq_access_control` | Row level security policies and role helpers. Removes the old public policies and helpers |
| `20261106000003_cliniq_core_and_public_functions` | Token numbering, queue ordering, and the public functions for booking and the live queue |
| `20261106000004_cliniq_staff_functions` | Registration, queue actions, patients, visits, prescriptions, reports, settings, staff |
| `20261106000005_cliniq_realtime_storage_grants` | Realtime broadcast, the private report bucket and its policies, function grants |
| `20261108000006_cliniq_invited_by_index` | One index the performance advisor asked for |
| `20261109000007_cliniq_staff_provisioning` | Staff accounts with a temporary password and forced change at first login, invitations that the person must accept, the email event log. Tables `clinic_invitations`, `email_events` |
| `20261110000008_cliniq_doctor_schedules` | Free start and end times, several timings a day, a different week per doctor, breaks, weekly holidays, leave and special days, and the booking rules that use them. Table `doctor_schedule_exceptions` |
| `20261111000009_cliniq_public_directory_and_otp` | The opt-in public clinic directory, one time codes (hashed, expiring, rate limited), the public live queue estimate, "my place" after verification. Table `booking_verifications` |

All three new migrations only add. They drop no table and no column and delete no data.

### Edge Functions (`supabase/functions/`)

| Function | Verify JWT | What it does |
| --- | --- | --- |
| `staff-account` | On | The owner creates a doctor or receptionist with a temporary password (an address that already has an account gets an invitation to accept instead), re-sends the welcome email, resets a temporary password; any signed-in person changes their password at first sign in. Holds the only code that uses the service key. |
| `booking-public` | **Off** (patients have no account) | Sends and checks patient codes, sends the booking confirmation, queue token and cancellation emails. Needs no sign in, and holds no secret answer. |
| `invite-staff` | On | Retired. A stub that answers 410. Deploy it over the old function so the old no-consent way cannot be used. |

### Dashboard settings you must change

These cannot be set from code. Without them the sign-in emails (verify email, reset password) will not work. Details and exact values are in `docs/EMAIL_SETUP.md`.

1. **Authentication, URL Configuration.** Set **Site URL** to your deployed address (for example `https://clinic.example.com`). Add **Redirect URLs**: `https://clinic.example.com/set-password` and, for local work, `http://localhost:5173/set-password`.
2. **Authentication, Emails (SMTP).** Supabase's built-in email sender is limited to a few messages an hour and sends only to your own team. Add your own SMTP provider (the guide uses Resend, host `smtp.resend.com`, port 465). Then paste the six templates from `supabase/templates/auth/` and their subjects.
3. **Authentication, Sign In / Providers, Email.** Decide whether **Confirm email** is on. Either works: if it is on, `/register` tells the new owner to confirm first.
4. **Authentication, Attack Protection.** Turn on leaked password protection if your plan includes it, and consider CAPTCHA (see "Remaining issues").
5. **Realtime.** The live "queue changed" signal needs the `realtime.messages` table to have partitions. On this project they are missing, so the signal is not delivered yet. The app does not depend on it: staff screens re-read the clinic every 10 seconds and patient pages every 10 seconds (the report figures every 30). If the signal service is fixed or enabled later, staff screens start updating within a second or two with no code change.

## How the backend is built

- **All writes go through database functions** (`security definer`, fixed `search_path`) that check who is calling, which clinic they belong to and which role they hold, then change data. Each answers `{ ok: true, ... }` or `{ ok: false, code, message, field_errors? }`. The browser has no direct write access to the tables.
- **Clinic isolation** comes from row level security on every table plus the function checks. A member of one clinic cannot read or write another clinic's rows.
- **Roles.** Owner, receptionist, doctor. Receptionists see patient names, phone numbers, visit dates and visit titles. They do not see diagnoses, notes, prescriptions or reports. Doctors read and write clinical records of their own clinic. The owner manages doctors, settings, staff and reports, which hold counts only.
- **Token numbers** are issued under a lock per clinic, doctor and day, so two people booking at the same moment never get the same number. Refused bookings do not use up a number.
- **Public pages** (home directory, booking, live queue, waiting room display) call eight public functions (listed below) that return token numbers, queue status and what a clinic chose to publish. Never patient names, phone numbers or medical information, and never owner or staff details. A patient reaches their own token through a secret key in their link, not a guessable number. The key column cannot be read by signed-in users either.
- **Home page directory is opt-in.** A clinic appears only after its owner switches on "List my clinic on the home page" and has given a city or an address. Search, specialisation and doctor filters, and paging all run in the database and treat text as plain text.
- **One time codes.** A clinic can require a code before a token is booked. The code is 6 digits, lives 10 minutes, allows 5 wrong tries, and is rate limited by phone, by email address and by network address (the last stored only as a hash). Only a keyed hash of the code is stored. After a right code the proof lasts 30 minutes for that one phone and at most 4 bookings. A code by email proves the email, not the phone, so "check my place" accepts text message codes only.
- **Doctor timetables.** Times are kept as clock times in the clinic's own time zone. Each doctor has a weekly pattern with several timings a day and breaks, plus date exceptions (closed, special timings, extra sessions). Online booking is refused on a closed day, for a session that is not on the timetable, and once that day's OPD is over (tomorrow stays open). Reception can still add a walk-in after hours on a working day (it joins the last session) but not on a closed day. A change that would leave booked patients outside the new hours is stopped with a warning that lists them; nothing is cancelled silently.
- **Reports and prescriptions files** live in a private bucket. A doctor of the same clinic gets a 60 second signed link, and every open is written to the audit log.
- **Audit log** records clinic registration, history reads, visit and prescription saves, report uploads and opens, settings changes, doctor changes and staff changes.
- **Staff accounts.** The owner fills in name, email, role (and the doctor's professional details) and a temporary password. The `staff-account` Edge Function (it needs the secret key, which never reaches the browser) checks the caller, makes the account through Supabase Auth (which hashes the password; the app never stores or logs it), marks it "must change password", and emails a welcome that holds **no password**. The owner gives the temporary password separately. At first sign in the person is sent to choose a new one, and a password-changed notice is emailed. If the email address already has an Apna Clinic account, it is **not** attached: that person gets an invitation to accept. Duplicates are refused. Every creation, invitation and email result is written to the audit log and the email log.
- **Honest email.** An email is reported as sent only when the provider accepted it. If email is not set up or the provider refuses, the owner sees that, with the real reason, and the account stays safe and usable.

### Tables (17)

The original 12: `clinics`, `clinic_settings`, `clinic_memberships`, `profiles`, `doctors`, `doctor_schedules`, `patients`, `appointments`, `queue_tokens`, `visits`, `prescriptions`, `patient_reports`. Added: `audit_log`, `clinic_invitations`, `email_events`, `doctor_schedule_exceptions`, `booking_verifications`. Every table has row level security, and the public (anon) role has no table access at all.

### Functions the browser can call

Public (no sign in), exactly eight: `get_public_clinic`, `book_token`, `get_my_token`, `cancel_my_token`, `get_public_queue`, `get_my_position`, `directory_search`, `directory_filters`. A database test fails if any other function becomes callable by the public.

Signed in: `register_clinic`, `my_clinics`, `get_staff_snapshot`, `add_walk_in`, `mark_arrived`, `mark_no_show`, `requeue_token`, `call_next`, `complete_token`, `skip_token`, `hold_token`, `resume_token`, `search_patients`, `get_patient_visit_list`, `get_patient_history`, `save_visit`, `save_prescription`, `register_report`, `authorize_report_download`, `update_clinic_settings`, `add_doctor`, `update_doctor`, `remove_doctor`, `list_staff`, `set_staff_active`, `get_report_series`, `get_report_month`, `get_doctor_schedule`, `set_weekly_schedule`, `add_schedule_exception`, `remove_schedule_exception`, `get_public_settings`, `update_public_settings`, `my_invitations`, `respond_invitation`, `revoke_invitation`.

Server only (service role, called by the Edge Functions): `staff_precheck`, `provision_staff`, `create_invitation`, `finish_first_login`, `staff_first_login_status`, `log_email_event`, `log_staff_event`, `staff_profile_name`, `otp_begin`, `otp_set_hash`, `otp_check`, `otp_cancel`, `booking_email_context`, and the older `attach_staff` (no deployed function calls it any more).

The Supabase security advisor lists these as "SECURITY DEFINER function executable" warnings. That is deliberate: each one checks the caller inside.

## Front end layout

```
src/domain/     Pure queue rules, shared by both modes.
src/backend/    The real backend: rpc wrapper, mappers, auth, staff data store, route gates, report upload, directory, code verification.
src/state/      The demo store, plus view hooks that pick the demo or real data source.
src/components/ Buttons, fields, dialogs, layout (the same design in both modes).
src/screens/    One file per screen. Remote* screens are the real-backend variants of login and home.
supabase/       Migrations, Edge Functions, the Auth email templates, database tests and the test-only API stand-in.
docs/           EMAIL_SETUP.md: email, text message and DNS setup for production.
e2e/            Browser test scripts.
```

Every screen reads data through hooks (`src/state/publicData.ts`, `src/state/staffData.ts`) and calls actions through `useActions()`. In demo mode those are the local store. In real mode they are the database functions. The screens themselves did not change layout or design.

## Deploying

1. Create the site on any static host. Build command `npm run build`, publish folder `dist`.
2. Set the three `VITE_` environment variables in the host's settings (not in code).
3. Make every address serve `index.html`. `vercel.json`, `netlify.toml` and `public/_redirects` are included for Vercel, Netlify and Cloudflare Pages. Without this, `/c/<clinic>/book` shows a "not found" page when opened directly.
4. Use HTTPS.
5. **Database.** Apply migrations 7, 8 and 9 to the project, in that order (see the status note below for how). They only add.
6. **Edge Functions.** Deploy `staff-account` (Verify JWT on), `booking-public` (Verify JWT **off**) and the stub `invite-staff` (see `docs/EMAIL_SETUP.md`, "Deploying the two Edge Functions").
7. **Secrets and dashboard.** Set the secrets listed under "Environment variables", then the Supabase dashboard settings (SMTP, six email templates, Site URL and Redirect URLs). All of it is explained step by step in `docs/EMAIL_SETUP.md`.
8. Open `/register`, create the owner account and the clinic, add the doctors under Settings, set each doctor's timetable, switch on "List my clinic on the home page" if you want it in the directory, then add reception and doctors with Add staff.
9. Send patients their clinic's booking link, shown in Settings under "Your clinic's public links", or let them find the clinic on the home page.

### Status of the project `gdcvtjdvmaivfafltqfq` at the time of this report

| Item | State |
| --- | --- |
| Migrations 1 to 6 | Applied |
| Migration 7 (staff provisioning) | **Applied** (recorded as `cliniq_staff_provisioning`) |
| Migration 8 (doctor timetables) | **Not applied.** The connector asked for confirmation of the statements in it (it drops the old versions of `book_token` and `create_token` and replaces them) and no answer arrived, so nothing was changed. It runs as one transaction, so nothing partial exists. |
| Migration 9 (directory and codes) | **Not applied** (needs 8 first) |
| Edge Functions | Only the old `invite-staff` is deployed. `staff-account`, `booking-public` and the stub are **not deployed** |
| Secrets, SMTP, email templates, redirect URLs | **Not set.** Only you can enter them |

Until 8 and 9 are applied, the new front end cannot book a token against this project (it calls `book_token` with the new arguments), and Add staff cannot work until `staff-account` is deployed. The older build keeps working on this project as it is.

To apply 8 and 9 yourself: open **SQL Editor** in the Supabase dashboard, paste the whole of `supabase/migrations/20261110000008_cliniq_doctor_schedules.sql`, run it, then do the same for `20261111000009_cliniq_public_directory_and_otp.sql`. Each file runs as one transaction: it either all applies or nothing does. **Do not use `supabase db push` on this project.** Its recorded history numbers migrations 1 to 6 differently from the files, so the command would try to apply them a second time.

## Tests

| What | Command | Result at the time of this report |
| --- | --- | --- |
| Unit tests | `npm test` | 254 passed, 9 files. Queue and settings rules, startup settings, the secret scanner, the real-backend data layer (including the staff store ordering fix), the email templates, the booking and staff Edge Function logic, the directory and code client |
| Type check and build | `npm run build` | Clean. The secret scan passed (96 files, 9 `VITE_` settings) |
| Database tests | `cd supabase/tests && npm install && node --test --test-concurrency=1 main.test.mjs` | 171 passed on a throwaway Postgres: structure and grants (17 tables, exactly 8 public functions), row level security for every role, queue rules, clinical records, concurrent booking and NEXT, staff accounts and invitations, doctor timetables, the public directory, codes and their rate limits |
| Real-backend browser tests | `bash scripts/run-e2e.sh e2e/<script>.cjs` (see below) | `supabase_flows` 133 of 133, `public_booking_flows` 112 of 112, `schedule_flows` 46 of 46, `responsive_public` 68 of 68. No console errors |
| Demo browser tests | `e2e/journeys.cjs`, `dialogs_mobile.cjs`, `a11y_responsive.cjs`, `links.cjs` | Unchanged demo behaviour: 120 of 120, 57 of 57, no axe violations, all 16 link targets open |
| Eight screen widths | `e2e/responsive_public.cjs` | 14 new screens and dialogs at 320, 360, 390, 430, 768, 1024, 1366 and 1920 px: no sideways scroll, nothing sticking out, every button and field at least 32 px, no axe violations (WCAG 2.2 AA and best practice) |
| Live smoke test | `supabase/tests/smoke/` | Not re-run for migrations 7 to 9 (they are not all applied to the project) |

`scripts/run-e2e.sh` builds the app against the stand-in, starts the stand-in API and the app, runs one script, and stops everything. One time setup: `npm install --no-save playwright axe-core && npx playwright install chromium`. Run one script at a time.

### The real-backend browser test and what it does not prove

The sandbox this was built in cannot reach `supabase.co`, so the browser could not be pointed at your hosted project. `supabase/tests/e2e/api-shim.mjs` is a test-only stand-in for the Supabase web API. It runs the real functions, policies and triggers from the migrations on a throwaway Postgres. The browser test drives the production build against it.

It proves: the screens, routing, forms, validation messages and the data flow work against the real SQL and against the real code of both Edge Functions (their rules, templates and hashing); clinic isolation and role limits hold; booking is concurrency safe; public pages carry no names or phones; codes are stored only as hashes; no console errors; no sideways scrolling and no axe violations at eight widths.

It does **not** prove: Supabase's own Auth service (the account creation call, the password hashing and the first sign-in change run against a stand-in), real email delivery (the email provider is a local fake that records what it receives; the Resend account has no verified sending domain), real text message delivery (no provider is set up; the fake phone shows the code), the Supabase Auth dashboard settings (SMTP, templates, redirect URLs), Realtime delivery, hosted Storage limits, CORS or network settings on your project, or the Deno runtime itself. Run the checklist below once on your project.

```bash
npm install --no-save playwright axe-core && npx playwright install chromium   # once
bash scripts/run-e2e.sh e2e/supabase_flows.cjs
bash scripts/run-e2e.sh e2e/public_booking_flows.cjs
bash scripts/run-e2e.sh e2e/schedule_flows.cjs
bash scripts/run-e2e.sh e2e/responsive_public.cjs
```

## Before real patients: run this once on your own project

1. Apply migrations 7 to 9, deploy the Edge Functions, set the secrets and the dashboard settings (Deploying, above, and `docs/EMAIL_SETUP.md`).
2. Open `/register`, create an owner and a clinic. Check the verification email arrives and its button opens the site.
3. In Settings, add a doctor and set its timetable (Schedule button). Try the example week: Monday 09:30 to 12:45 and 17:30 to 20:15, Wednesday closed, Sunday holiday.
4. Add staff: a receptionist and a doctor, each with a real mailbox you control and a temporary password. Confirm the welcome email arrives with **no password in it**, sign in with the temporary password, and confirm you are made to choose a new one before anything else. Confirm the "password changed" email.
5. Switch on "List my clinic on the home page" and open `/` in a private window. Find the clinic by name and by city. Book a token from a phone.
6. Switch on "Ask patients to verify with a code". Book again: with a text message provider set up you receive a text; without one the page must say "No code was sent" and offer the email way.
7. Mark the token arrived as the receptionist, press NEXT as the doctor, add a note and a prescription. Open the live queue on another phone.
8. Upload a PDF and a photo from the history page and open them. Check a 10 MB limit and a wrong file type are refused.
9. Sign in as the receptionist and confirm no diagnosis, note, prescription or report is visible anywhere.
10. Register a second clinic with another email. Confirm it sees none of the first clinic's patients or staff.
11. Request a password reset and open the link twice: the second use must say the link is used or expired.

## Remaining issues and limits

What could not be verified here, because it needs your accounts:

- **Real email delivery.** The email provider account has no verified sending domain, so no real email could be sent from this work. The tests use a local fake that records what it is given, and they do prove that the app says "sent" only when the provider accepts, and says "not sent" with the real reason otherwise.
- **Real text message delivery.** No SMS provider is set up. The adapter for Twilio is written and unit tested; India also needs DLT registration before messages reach phones.
- **Supabase Auth dashboard settings.** SMTP, the six templates, Site URL, redirect URLs, leaked password protection and CAPTCHA are dashboard settings that nothing here can set or check.
- **The real Supabase Auth admin calls** (create user, update password) were run only against a stand-in.
- **Migrations 8 and 9 and the Edge Function deployment** are not applied to the project yet (see the status table under Deploying).

Known limits:

- **No live push for patients.** The public live queue and directory check every 10 and 15 seconds, and again when the tab becomes visible. Staff screens use Realtime when it is delivered and the same checking otherwise. Instant updates for anonymous visitors would need a signal-only broadcast channel, which could not be tested here.
- **Realtime signals are not delivered on this project** (missing partitions), so staff screens also rely on checking every 10 seconds.
- **Codes only prove the contact.** They stop casual abuse. A determined person with many phone numbers can still book; CAPTCHA is not built.
- **A patient can book again to get their own token back.** Booking again with the same name and number returns that person's token link. Anyone who knows both can reach it.
- **The owner is not also a doctor.** To see patients, the owner adds a doctor login for themselves.
- **Receptionists cannot upload or open reports.** Reports are clinical, so only doctors can.
- **Doctor timetable.** Times are in the clinic's time zone. Online booking is open for today and tomorrow only (unchanged). A change that leaves booked patients outside the new timings needs the owner to confirm; those bookings are kept, not cancelled.
- **Advisors.** The security advisor's "SECURITY DEFINER" warnings are deliberate (5 public, 32 signed-in on this project before migrations 8 and 9). Leaked password protection is a dashboard switch that is off.
- **The Privacy Policy and Terms describe the real data handling in plain words but were not reviewed by a lawyer.** A clinic holding health data in India should have them reviewed against the applicable law.
- **English only.** Not tested: browsers other than Chromium, real phones, screen readers, the printed token slip, voice announcements.

## Demo mode

Demo mode is the original prototype: 12 screens, data in `localStorage`, a visible login code, and a "Reset demo data" button in the footer. Demo logins are in `src/domain/demoStaff.ts`: reception 9000000101, General OPD doctor 9000000102, Child OPD doctor 9000000104, owner 9000000103, code `1234`. Do not enter real patient details in demo mode.

Queue rules (both modes): token numbers start at 1 each day for each doctor and are never reused; online bookings and walk-ins share one queue; the same name and number cannot hold two active tokens with one doctor on one day; a doctor's daily limit stops online booking, and reception can override it for walk-ins; the owner can switch online booking off; NEXT finishes the current patient and calls the next, ignoring double presses and stale screens; wait times are estimates over open hours only.

# Email setup for Apna Clinic

This guide shows you how to make Apna Clinic send real emails that reach real inboxes. You do not need to be an expert. Follow the steps in order. Set aside about one hour. DNS changes can take longer to show up, so some steps need waiting.

You will need:

- A domain name you own (for example `yourclinicapp.in`).
- Access to the place where that domain's DNS is managed (the website where you bought the domain, or Cloudflare).
- Your Supabase project dashboard.
- A free account with an email provider. This guide uses **Resend** as the worked example.

Two kinds of email come out of the app. Keep them apart in your mind:

| Kind | Examples | Sent by | Set up in |
| --- | --- | --- | --- |
| Sign-in emails | confirm email, reset password, magic link | Supabase Auth | Steps 3, 4 and 5 |
| App emails | staff welcome, invitation, OTP code, booking and cancellation mails | Our Edge Functions | Step 6 |
| Text message codes | the 6 digit code a patient types before booking | Our Edge Function, through Twilio | Step 6b |

### The nine Apna Clinic emails

Every email below has the Apna Clinic name, a short warm message, one clear button and a plain text copy. None contains a password. Patient emails carry the first name only, never a phone number or anything medical.

| # | Email | Who gets it | Sent by | Where its design lives |
| --- | --- | --- | --- | --- |
| 1 | Staff invitation | A person who **already has** an Apna Clinic account and is invited by an owner. They must accept; nothing is attached until they do | Edge Function `staff-account` | `_shared/email/templates.ts` (`staff_invitation`) |
| 2 | Staff activation | A **new** doctor or receptionist whose account the owner just created with a temporary password. It points to the sign in page and reminds them to choose a new private password | Edge Function `staff-account` | `templates.ts` (`staff_activation`) |
| 3 | Email verification | A new clinic owner | Supabase Auth, template "Confirm sign up" | `supabase/templates/auth/confirmation.html` |
| 4 | Password reset | Anyone who asks to reset | Supabase Auth, template "Reset password" | `supabase/templates/auth/recovery.html` |
| 5 | Password changed | A staff member who just changed their password | Edge Function `staff-account` | `templates.ts` (`password_changed`) |
| 6 | Patient OTP (by email) | A patient who chose the email way to verify | Edge Function `booking-public` | `templates.ts` (`patient_otp`) |
| 7 | Appointment confirmation | A patient who gave an email when booking | Edge Function `booking-public` | `templates.ts` (`appointment_confirmation`) |
| 8 | Queue token confirmation | The same patient, with the live queue link | Edge Function `booking-public` | `templates.ts` (`queue_token_confirmation`) |
| 9 | Appointment cancellation | A patient who cancelled their own token | Edge Function `booking-public` | `templates.ts` (`appointment_cancellation`) |

Emails 3 and 4 are pasted into the Supabase dashboard (Step 4). The other seven are sent by the Edge Functions and need the secrets in Step 6. The other four Auth templates (invite, magic link, change email, reauthentication) are also provided so nothing in the sign-in flow falls back to Supabase's plain default wording.

---

## 1. Why the default Supabase email is not for production

Supabase sends a few emails for free so you can try things out. It is not meant for real use.

- **Tiny hourly limit.** Only a few emails per hour for the whole project.
- **Team members only.** It sends only to people who are members of your Supabase team. A real clinic user or patient will not receive anything.
- **Shared sender.** The mail comes from a shared Supabase address, not from Apna Clinic.
- **Poor deliverability.** Many inboxes put these emails in spam or block them.

So before you go live, you must connect your own sending service. The next steps do that.

---

## 2. Choose a provider and verify a sending domain

Any good transactional email provider works. Resend is simple and has a free plan. Check the provider's pricing page for the current free limits.

### Worked example with Resend

1. Create an account at resend.com and sign in.
2. Open **Domains** and choose **Add Domain**.
3. Type a **subdomain**, for example `mail.yourdomain.com`. Do not use your main domain. A subdomain keeps your normal email and your app email separate and protects your reputation.
4. Choose the region closest to your users.
5. Resend now shows a short list of **DNS records** (usually one MX record and two TXT records). Keep this page open.
6. Open your DNS provider in another tab. Add each record exactly as Resend shows it. Copy the values. Do not type them by hand.
7. Go back to Resend and press **Verify**.
8. Wait until the status says **Verified**. This often takes a few minutes. Sometimes it takes a few hours. If it fails, check each record for typing mistakes or extra spaces, then press Verify again.
9. Open **API Keys** and choose **Create API Key**.
10. Give it a name such as `supabase-auth`. Set the permission to **Sending access**. If asked, limit it to your domain.
11. Copy the key at once. It starts with `re_`. Resend shows it only one time. Store it in a password manager.
12. Decide the sender address. Use this style:

```
Apna Clinic <no-reply@mail.yourdomain.com>
```

The part after `@` must be the subdomain you verified.

Never put the API key in the website code, in a `VITE_` setting, in a chat or in a screenshot. The website is public. Anything in it can be read by anyone.

---

## 3. Connect Supabase Auth to your provider (custom SMTP)

This makes the sign-in emails (confirm email, reset password and so on) go through Resend.

1. Open your project in the Supabase dashboard.
2. Go to **Authentication > Emails > SMTP Settings**.
3. Turn on **Enable custom SMTP**.
4. Fill in the form:

| Field | Value |
| --- | --- |
| Sender email | `no-reply@mail.yourdomain.com` |
| Sender name | `Apna Clinic` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | your Resend API key (the one starting with `re_`) |

5. Press **Save**.
6. After you switch on custom SMTP, Supabase starts with a limit of about 30 emails per hour. You can change it in **Authentication > Rate Limits**.

**Why our own app emails do not use SMTP.** Supabase Edge Functions cannot use SMTP ports 25 and 587. Port 465 is allowed, but it is not the common route. For this reason our app emails (Step 6) are sent through the provider's HTTPS API instead. This is normal and it is more reliable. It does mean you need to set the secrets in Step 6 as well. Step 3 alone is not enough.

---

## 4. Paste the six Auth email templates

The templates are in `supabase/templates/auth/`. They are plain HTML. Each one uses the same look as the app emails.

1. Go to **Authentication > Emails**.
2. Open each template in the table below.
3. Delete the old content. Paste the full content of the matching file.
4. Paste the subject from the table into the **Subject** box.
5. Press **Save**.

| Dashboard template name | File | Subject |
| --- | --- | --- |
| Confirm sign up | `confirmation.html` | Confirm your email address for Apna Clinic |
| Invite user | `invite.html` | You have been invited to Apna Clinic |
| Magic link | `magic_link.html` | Your Apna Clinic sign-in link |
| Change email address | `email_change.html` | Confirm your new email address for Apna Clinic |
| Reset password | `recovery.html` | Reset your Apna Clinic password |
| Reauthentication | `reauthentication.html` | Your Apna Clinic verification code |

The same subjects are listed in `supabase/templates/auth/SUBJECTS.md`.

Do not rename the `{{ .ConfirmationURL }}` style parts inside the files. Supabase fills them in when it sends each email.

---

## 5. URL configuration and Auth settings

The buttons in the emails open links on your website. Supabase only allows links to places you list here. If this is wrong, the links will not work.

1. Go to **Authentication > URL Configuration**.
2. Set **Site URL** to your production address, for example `https://yourdomain.com`. Do not end it with a slash.
3. Under **Redirect URLs**, add these three:

```
https://yourdomain.com
https://yourdomain.com/set-password
https://yourdomain.com/login
```

4. Press **Save**.
5. Go to **Authentication > Sign In / Providers** and open **Email**. (Menu names move a little between dashboard versions. Use the search box if you cannot find it.)
6. Set the email link expiry (**Email OTP Expiration**) to `3600` seconds. That is one hour. It is a good balance for password reset links.
7. Make sure **Confirm email** is **on**. New clinic owners must confirm their address.
8. Make sure **Secure email change** is **on**. A change of email address must then be confirmed from the old and the new address.

While you test on your own computer you may also add `http://localhost:5173/login`. Remove it before launch.

---

## 6. Secrets for the app emails (Edge Functions)

Our Edge Functions send the staff welcome mail, the invitation, the OTP code and the booking mails. They read their settings from **secrets**. Secrets are private values stored by Supabase. They never reach the website.

| Secret | Required | Example value |
| --- | --- | --- |
| `RESEND_API_KEY` | Yes | `re_xxxxxxxxxxxxxxxx` |
| `EMAIL_FROM` | Yes | `Apna Clinic <no-reply@mail.yourdomain.com>` |
| `EMAIL_REPLY_TO` | Optional | `help@yourdomain.com` (a mailbox you really read) |
| `APP_BASE_URL` | Yes | `https://yourdomain.com` (no slash at the end) |
| `SUPPORT_EMAIL` | Optional | `help@yourdomain.com` (shown in the email footer) |
| `OTP_HASH_SECRET` | Yes, for patient codes | A long random string, at least 32 characters. Make one with `openssl rand -base64 48`. |

`OTP_HASH_SECRET` is what keeps patient codes safe. The server never stores a code. It stores only a keyed hash of it, made with this secret. Keep it private, never reuse another secret for it, and do not change it while patients are in the middle of verifying (a changed secret makes the codes that were just sent stop working; patients simply ask for a new one).

`RESEND_API_KEY` can be the same key as in Step 3. It is safer to create a second key named `app-emails`, so you can cancel one without breaking the other.

### Option A: in the dashboard

1. Go to **Edge Functions > Secrets**.
2. Choose **Add new secret**.
3. Type the name and the value. Save.
4. Repeat for each secret.

### Option B: with the Supabase command line

Run this in your project folder. Use your own values.

```
supabase secrets set RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
supabase secrets set EMAIL_FROM="Apna Clinic <no-reply@mail.yourdomain.com>"
supabase secrets set APP_BASE_URL=https://yourdomain.com
supabase secrets set EMAIL_REPLY_TO=help@yourdomain.com SUPPORT_EMAIL=help@yourdomain.com
supabase secrets set OTP_HASH_SECRET="$(openssl rand -base64 48)"
```

Check the names with `supabase secrets list`. It shows names only, never the values.

New secrets are used the next time a function runs. If a change does not show up, deploy the function again.

The email design for the app emails lives in `supabase/functions/_shared/email/templates.ts`. If you change that file, paste the new version into the function that uses it and deploy again.

---

## 6b. Text message codes for patients (optional, needs your own account)

A patient can prove their contact before booking in two ways: a text message to their mobile, or an email code. The email way works with Step 6 alone. The text message way needs an SMS provider. The app has a ready adapter for **Twilio**.

| Secret | Required | Meaning |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | For text messages | Starts with `AC`. In the Twilio console. |
| `TWILIO_AUTH_TOKEN` | For text messages | Private. In the Twilio console. |
| `TWILIO_MESSAGING_SERVICE_SID` | One of these two | Starts with `MG`. Preferred. |
| `TWILIO_FROM` | One of these two | A phone number you own, written like `+1555...` |

How the app behaves, so you are not surprised:

- **If these secrets are missing, nothing is sent and the patient is told so.** The page says "No code was sent", offers the email way when it is set up, and never pretends. The clinic can then leave "Ask patients to verify with a code" off, or use email codes.
- **Sending to Indian numbers.** Indian rules (TRAI) require a registered sender ID and a registered message template (DLT registration) before text messages reach phones in India. This is done with Twilio or your telecom provider and can take days. Until it is done, test messages to Indian numbers may be blocked. Register the template text exactly as the app sends it: `<code> is your Apna Clinic verification code. It expires in 10 minutes. Do not share it with anyone.`
- The app cannot see whether the phone really received the message. "Sent" means the provider accepted it. Check delivery in the Twilio console under **Monitor > Logs > Messaging**.

### How codes are kept safe

| Rule | Value |
| --- | --- |
| A code lives for | 10 minutes |
| Wrong tries on one code | 5, then a new code is needed |
| Codes for one phone | 3 in 10 minutes, 10 a day |
| Codes sent to one email address | 5 an hour |
| Codes requested from one network address | 20 an hour (stored only as a hash) |
| After a correct code | the proof is good for 30 minutes, for that one phone number, for up to 4 bookings |
| What is stored | a keyed hash of the code, never the code, and no provider text |

A code from an **email** proves the patient owns that email, not the phone. So "check my place in the queue" (which shows one patient's own token) accepts only a **text message** code.

### Deploying the two Edge Functions

The app has two Edge Functions. Their source is in `supabase/functions/`.

| Function | Who may call it | Turn "Verify JWT" |
| --- | --- | --- |
| `staff-account` | A signed in clinic owner (the function verifies the sign in, and the database refuses anyone who is not that clinic's owner) | **On** |
| `booking-public` | Any visitor (patients are not signed in) | **Off** |

`booking-public` must have JWT verification off, because patients have no account. It is safe because it holds no secret answer: it only sends codes, checks codes with the database's own limits, and sends mails for tokens that the caller can prove they hold (a token's private key).

With the command line:

```
supabase functions deploy staff-account
supabase functions deploy invite-staff
supabase functions deploy booking-public --no-verify-jwt
```

The first version of the app had a function called `invite-staff`. It is replaced by `staff-account`. If `invite-staff` is deployed in your project, deploy the small stub in `supabase/functions/invite-staff/` over it. The stub does nothing except answer "this has been replaced" (HTTP 410), so the old way of adding staff, which attached an existing account without asking that person, cannot be used any more.

---

## 7. SPF, DKIM and DMARC in plain words

These three records prove that an email really comes from you. Inboxes check them. Without them your mail goes to spam.

- **SPF** is a list of servers that may send mail for your domain.
- **DKIM** is a secret stamp on each email. The inbox checks the stamp against a public key in your DNS.
- **DMARC** tells inboxes what to do when SPF or DKIM fails. It can also send you reports.

Resend gives you the SPF and DKIM records in Step 2. **Copy the exact values the provider shows.** The examples below only show the shape. Do not use them as they are.

| Type | Host (name) | Value (shape only) |
| --- | --- | --- |
| TXT (SPF) | `send.mail` | `v=spf1 include:<provider-sending-host> ~all` |
| MX | `send.mail` | `<provider-feedback-host>` with priority `10` |
| TXT (DKIM) | `resend._domainkey.mail` | `p=<long-public-key-from-provider>` |
| TXT (DMARC) | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com` |

Some DNS websites want the full name (`send.mail.yourdomain.com`). Others add your domain by themselves, so you type only `send.mail`. If one style fails, try the other.

### DMARC, step by step

1. Start with `p=none`. It only watches and sends you reports. It blocks nothing. Use a real mailbox in `rua=mailto:...` that you can read.
2. Wait a few weeks. Read the reports. Check that your own app emails pass.
3. Change `p=none` to `p=quarantine`. Failing mail now goes to spam.
4. After a few more clean weeks, change it to `p=reject`. Failing mail is refused.

Your DMARC record sits on the main domain (`_dmarc.yourdomain.com`). It also covers the `mail` subdomain.

### Check how you are doing

- **mail-tester.com**: it gives you a one-time address. Send an Apna Clinic email to it (for example a password reset). It shows a score out of 10 and tells you what is wrong. Aim for 9 or more.
- **Google Postmaster Tools**: add your domain to see how Gmail judges your mail. It needs a fair amount of mail before it shows data. A small clinic may see nothing for a while. That is normal.

---

## 8. Test safely

Do not test with real patients or real clinic staff. Use the provider's test addresses. They never reach a person.

| Send to | What happens |
| --- | --- |
| `delivered@resend.dev` | The email is delivered successfully. |
| `bounced@resend.dev` | The email bounces (it fails to deliver). |
| `complained@resend.dev` | The email is marked as spam by the receiver. |

How to check:

1. Trigger an email from the app, for example add a staff member or request an OTP using one of the addresses above.
2. Open the Resend dashboard and go to **Emails**.
3. Find the message. Read its status: **Delivered**, **Bounced** or **Complained**.
4. Click the message to see the full detail and any error text.

Text message codes cannot be tested with a test address. Use your own phone number, with Twilio set up as in Step 6b. The email way of getting a code can be tested with the table above.

For the Supabase sign-in emails, request a password reset for a test account that uses your own mailbox. Then look in the Supabase dashboard under **Logs > Auth** if nothing arrives.

Also test one email to a real Gmail address and one to another provider (Outlook or Yahoo). Check that it lands in the inbox, not in spam. Open the email on a phone. The buttons must be easy to tap.

---

## 9. Troubleshooting

| Problem | Likely cause | What to do |
| --- | --- | --- |
| The email never arrives | The address is wrong. The provider rejected the mail. The SMTP details or the API key are wrong. A rate limit was hit. | 1. Look in the Resend dashboard. See whether the mail is there and what its status is. 2. Check the spam folder. 3. Check **Logs > Auth** in Supabase. 4. Re-check the SMTP form (Step 3) and the secrets (Step 6). |
| It lands in spam | SPF, DKIM or DMARC is missing or wrong. The domain is new. | Confirm the domain says **Verified**. Add the DMARC record (Step 7). Send from the subdomain. Test on mail-tester.com. Ask the person to mark the mail as "Not spam". New domains need a few weeks to build trust. |
| Error `403` "domain is not verified" | The sender in `EMAIL_FROM` uses a domain that is not verified in Resend. | Open **Domains** in Resend. Check the status is **Verified**. Make sure `EMAIL_FROM` ends with exactly that domain, for example `@mail.yourdomain.com`. Fix typos in the DNS records and press **Verify** again. |
| The link says expired or invalid | Links work only once and expire (reset links after 1 hour). Some mail programs open links on their own to scan them, which uses the link up. The person clicked an old email. | Send a fresh email. Use only the newest one. In the app, use **Resend sign-in email**. If it keeps happening, open the link on the same phone or computer where you asked for it. |
| The link opens but the app shows an error | The address is not on the Redirect URL list. The Site URL is wrong. `APP_BASE_URL` is wrong. | Go back to Step 5. Compare every address letter by letter, including `https` and no extra slash. Check `APP_BASE_URL` in Step 6. Then send a new email. |
| "Rate limit exceeded" or "email rate limit" | Too many emails in a short time. Supabase limits Auth emails per hour. The provider also has limits. | Wait one hour and try again. Do not press resend again and again. To raise the Supabase limit, go to **Authentication > Rate Limits**. For the provider limits, check your plan in its dashboard. |

If none of this helps, copy the exact error text from the Resend dashboard or from the app. The error text usually tells you the real reason.

---

## 10. What the app does when email fails

The app is built to be honest about email.

- It **never says an email was sent** unless the email provider accepted it.
- If the provider **rejects** the email, the clinic owner sees the **real reason** on the screen (for example "domain is not verified"). Use the table in Step 9 to fix it.
- The owner can use **Resend sign-in email** to try again after fixing the problem. There is no need to create the person again.
- The same goes for patient codes. If a code could not be sent (no provider set up, or the provider refused), the patient sees "No code was sent" and the unsent code is deleted, so it cannot be guessed later. Provider wording is never shown to patients; the clinic owner can read the details in the Edge Function logs.
- A booking never fails because a confirmation email failed. The patient is told plainly whether the email was sent, was not sent, or could not be sent.
- No email contains a password. The clinic gives each new staff member their temporary password separately. The person must choose a new private password the first time they sign in.
- Patient emails never contain a phone number, a diagnosis or a surname. They hold only the first name, token number, doctor, clinic, date and session.

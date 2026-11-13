# Subjects for the Supabase Auth email templates

Paste each file into **Dashboard > Authentication > Emails** (open the matching template), and paste the subject into the **Subject** box of the same template. The six files are plain HTML with Supabase variables such as `{{ .ConfirmationURL }}`. Do not change the variable names.

| Dashboard template | File | Subject (paste exactly) |
| --- | --- | --- |
| Confirm sign up | `confirmation.html` | Confirm your email address for Apna Clinic |
| Invite user | `invite.html` | You have been invited to Apna Clinic |
| Magic link | `magic_link.html` | Your Apna Clinic sign-in link |
| Change email address | `email_change.html` | Confirm your new email address for Apna Clinic |
| Reset password | `recovery.html` | Reset your Apna Clinic password |
| Reauthentication | `reauthentication.html` | Your Apna Clinic verification code |

## Variables used

- `{{ .ConfirmationURL }}`: the secure link behind the button (not used in reauthentication).
- `{{ .Token }}`: the 6 digit code (reauthentication only).
- `{{ .Email }}` and `{{ .NewEmail }}`: the person's current and new email address.
- `{{ .SiteURL }}`: your Site URL, shown in the footer.
- `{{ .Data.full_name }}`: the name saved on the account. If it is empty the greeting says "Hello there,".

No template contains or asks for a password. The app's own emails (staff welcome, booking mails and so on) do not use these files. They come from `supabase/functions/_shared/email/templates.ts`.

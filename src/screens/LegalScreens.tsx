// Privacy Policy and Terms and Conditions. These describe what this demo prototype actually does.
// They are plain language summaries, not legal advice, and have not been reviewed by a lawyer.

import { Link } from 'react-router-dom';
import { IS_SUPABASE } from '../backend/mode';
import { Notice, PageHeader } from '../components/ui';

const UPDATED = '31 October 2026';

function ReviewNotice() {
  return (
    <Notice kind="info" title="About this page" live={false}>
      <p>
        This page describes a demonstration prototype. It is not legal advice and has not been reviewed by a lawyer. A
        live clinic service would need its own policy that matches how it really handles data.
      </p>
    </Notice>
  );
}

function DemoPrivacy() {
  return (
    <div className="prose">
      <PageHeader title="Privacy Policy" intro={`Last updated ${UPDATED}`} />
      <ReviewNotice />

      <h2>What this app is</h2>
      <p>
        Clinic Queue Management is a prototype for trying out a clinic token and queue system. It uses sample data. It is
        not a live clinic service and it is not meant to hold real patient records.
      </p>

      <h2>What information the app handles</h2>
      <ul>
        <li>Names and mobile numbers that you type into the booking, walk-in and patient search forms.</li>
        <li>Visit notes, advice and the names (not the contents) of files that a doctor attaches in the demo.</li>
        <li>Demo settings, such as the clinic name, token limits and the doctor list.</li>
        <li>Which tokens your browser booked, so you can return to your live queue.</li>
        <li>Which demo role you are using in a tab, after you use the demo login.</li>
      </ul>
      <p>Please do not enter real patient details. The sample records are invented.</p>

      <h2>Where it is stored</h2>
      <p>
        All of this stays inside your own browser. The app saves it in your browser's local storage and session storage
        so a page refresh does not reset the demo. The app has no database and no server of its own, and it does not
        send these details anywhere. Local storage is not encrypted and is not a secure place for real records. Anyone
        who can use this browser profile can read it.
      </p>

      <h2>What the app does not do</h2>
      <ul>
        <li>It does not send SMS, WhatsApp messages, emails or one time codes. The demo login code is shown on screen.</li>
        <li>It does not take payments.</li>
        <li>It does not use cookies, analytics, advertising or tracking.</li>
        <li>It does not load fonts, scripts or images from other websites.</li>
        <li>It does not suggest diagnoses or medicines.</li>
      </ul>

      <h2>Things that happen in your browser</h2>
      <ul>
        <li>
          The monthly report export builds a CSV file in your browser and saves it to your device. It contains counts
          only, with no names or phone numbers.
        </li>
        <li>
          The optional voice announcement on the waiting room display uses your browser's speech feature. Depending on
          the browser and device, the spoken text may be processed by the browser's or device maker's speech service.
          The text contains only a token number and an OPD name.
        </li>
        <li>Printing a token slip uses your browser's print dialog.</li>
      </ul>

      <h2>Website hosting</h2>
      <p>
        Whoever hosts this website may keep ordinary server logs, such as the address of your device and the pages
        requested. That happens outside this app's code and this app cannot see those logs.
      </p>

      <h2>Your choices</h2>
      <p>
        Use <strong>Reset demo data</strong> at the bottom of any page to remove everything you added and restore the
        sample data. You can also clear this site's data in your browser settings, which removes all of it.
      </p>

      <h2>Changes</h2>
      <p>
        If this prototype is turned into a live service, this policy must be replaced with one that describes the real
        data handling before anyone uses it with real patients. See also the <Link to="/terms">Terms and Conditions</Link>.
      </p>
    </div>
  );
}

function DemoTerms() {
  return (
    <div className="prose">
      <PageHeader title="Terms and Conditions" intro={`Last updated ${UPDATED}`} />
      <ReviewNotice />

      <h2>Demonstration only</h2>
      <p>
        This app is a prototype made to show how a clinic queue could work. Everything in it, including the clinic,
        doctors, patients and visit notes, is sample data.
      </p>

      <h2>Not medical advice</h2>
      <p>
        The app does not give medical advice, diagnoses or treatment recommendations. Notes and advice shown in the demo
        are examples only. If you need urgent medical care, contact a doctor or your local emergency number (112 in
        India).
      </p>

      <h2>Estimates</h2>
      <p>
        Waiting times and appointment times are estimates based on a number of minutes per patient set in the demo. Real
        consultations take different times, so the estimates can be wrong.
      </p>

      <h2>What you may do</h2>
      <ul>
        <li>Try every screen and enter made up names and numbers.</li>
        <li>Do not enter real patient information.</li>
        <li>Do not use the demo login, which has no real security, to protect real information.</li>
      </ul>

      <h2>No guarantee</h2>
      <p>
        The prototype is provided as it is, without any promise that it is complete, always available or free of
        mistakes. Data kept in your browser can be lost at any time, for example if you clear your browser data.
      </p>

      <h2>Privacy</h2>
      <p>
        How the app handles information is described in the <Link to="/privacy">Privacy Policy</Link>.
      </p>
    </div>
  );
}

export function NotFoundScreen() {
  return (
    <div className="prose">
      <PageHeader title="Page not found" />
      <p>{IS_SUPABASE ? 'This address does not match any page.' : 'This address does not match any screen in the demo.'}</p>
      <p>
        <Link to="/">{IS_SUPABASE ? 'Go to the home page' : 'Go to the demo home page'}</Link>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The same pages for the real backend. They describe what the system does with real clinic data.
// ---------------------------------------------------------------------------------------------------------------

function RemoteReviewNotice() {
  return (
    <Notice kind="warning" title="Have this page reviewed before you rely on it." live={false}>
      <p>
        This is a plain language description of how the software handles information. It is not legal advice and has not
        been reviewed by a lawyer. The clinic that uses Cliniq decides what is collected from its patients and is
        responsible for it, so each clinic should have its own privacy policy and terms checked against the law that
        applies to it, including India's data protection law.
      </p>
    </Notice>
  );
}

function RemotePrivacy() {
  return (
    <div className="prose">
      <PageHeader title="Privacy Policy" intro={`Last updated ${UPDATED}`} />
      <RemoteReviewNotice />

      <h2>What Cliniq is</h2>
      <p>
        Cliniq lets a clinic give out queue tokens, run its queue and keep visit records. Each clinic's information is kept
        apart from every other clinic's by the database itself.
      </p>

      <h2>What information is collected</h2>
      <ul>
        <li>From patients who book online: the name and mobile number typed into the booking form, and the booking itself.</li>
        <li>From reception: names and mobile numbers of walk-in patients, and the status of each token.</li>
        <li>From doctors: visit dates, symptoms, diagnoses, consultation notes, advice, prescriptions and uploaded reports or images.</li>
        <li>From clinic staff: name, email address and role, so each person can sign in and see only what their role allows.</li>
        <li>A log of important actions, such as who opened a patient's history and when.</li>
      </ul>

      <h2>Who can see it</h2>
      <ul>
        <li>
          <strong>The public</strong> (the booking page, live queue and waiting room display) sees token numbers and queue
          status only. These pages never show patient names, phone numbers or medical information.
        </li>
        <li>
          <strong>Reception staff</strong> see patient names, mobile numbers, visit dates and visit titles. They do not see
          diagnoses, consultation notes, prescriptions or reports.
        </li>
        <li>
          <strong>Doctors</strong> of the clinic can read and write clinical records of that clinic's patients.
        </li>
        <li>
          <strong>The clinic owner</strong> manages doctors, settings and staff logins, and sees clinic reports. The
          reports contain counts only.
        </li>
        <li>Staff of one clinic cannot see another clinic's patients.</li>
      </ul>

      <h2>Where it is stored</h2>
      <p>
        Records are stored in a database and a private file store hosted by Supabase. Uploaded reports are kept in private
        storage and are opened only through a short lived link given to a signed in doctor of the same clinic. Data is sent
        over encrypted connections.
      </p>

      <h2>What Cliniq does not do</h2>
      <ul>
        <li>It does not send SMS or WhatsApp messages. A patient's token is shown on screen and kept in the patient's own browser.</li>
        <li>It does not take payments.</li>
        <li>It does not use advertising or tracking, and it does not load fonts or scripts from other websites.</li>
        <li>It does not suggest diagnoses or medicines.</li>
      </ul>

      <h2>On your device</h2>
      <p>
        The patient's browser remembers the tokens it booked, so the patient can return to the live queue. Signed in staff
        keep a sign in session in the browser. The optional voice announcement on the waiting room display uses the
        browser's speech feature, and the spoken text has only a token number and a clinic area name.
      </p>

      <h2>Your choices</h2>
      <p>
        A patient who wants a record corrected or removed should ask the clinic, because the clinic holds the record. A
        patient can cancel an online token from the confirmation page.
      </p>

      <h2>Changes</h2>
      <p>
        See also the <Link to="/terms">Terms and Conditions</Link>.
      </p>
    </div>
  );
}

function RemoteTerms() {
  return (
    <div className="prose">
      <PageHeader title="Terms and Conditions" intro={`Last updated ${UPDATED}`} />
      <RemoteReviewNotice />

      <h2>Not medical advice</h2>
      <p>
        Cliniq does not give medical advice, diagnoses or treatment recommendations. If you need urgent medical care,
        contact a doctor or your local emergency number (112 in India).
      </p>

      <h2>Estimates</h2>
      <p>
        Waiting times and appointment times are estimates based on the minutes per patient the clinic has set. Real
        consultations take different times, so the estimates can be wrong. The doctor's order of patients can also change.
      </p>

      <h2>Booking a token</h2>
      <ul>
        <li>Give your real name and your own mobile number. The clinic uses them to find your visit.</li>
        <li>A clinic limits how many tokens it gives each day and how many one phone number can book online.</li>
        <li>A token that is not used may be marked as not arrived by the clinic.</li>
      </ul>

      <h2>For clinic staff</h2>
      <ul>
        <li>Use your own login. Do not share your password.</li>
        <li>Open a patient's record only when you need it for their care or for running the clinic.</li>
        <li>The clinic owner is responsible for who is given a login, and for switching off logins that are no longer needed.</li>
      </ul>

      <h2>No guarantee</h2>
      <p>
        The service is provided as it is, without any promise that it is always available or free of mistakes. The clinic
        should keep its own way of seeing patients if the service is not working.
      </p>

      <h2>Privacy</h2>
      <p>
        How information is handled is described in the <Link to="/privacy">Privacy Policy</Link>.
      </p>
    </div>
  );
}

export const PrivacyScreen = IS_SUPABASE ? RemotePrivacy : DemoPrivacy;
export const TermsScreen = IS_SUPABASE ? RemoteTerms : DemoTerms;

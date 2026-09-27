# Admissions implementation test guide

Use test accounts and test payment references only. Apply both `20260927` migrations before testing. Configure SMTP in `.env` from `.env.example`; never commit credentials.

Also apply `20260927_complete_admissions_finance.sql` before testing the items below.

## Visual card system

1. Confirm summary cards have a white face and retain their former semantic colour as a left-and-bottom shadow.
2. Confirm each relevant icon uses that same solid green, blue, amber, red, violet, or neutral colour.
3. Check desktop and mobile widths for overlap.

## Debtors and Creditors

1. Mark only genuine mandatory payment types as **Compulsory fee obligation**.
2. As Admin or Bursary open `/staff/fees/debtors-creditors` and filter by session, school, department and programme.
3. Confirm `expected - confirmed paid = balance`; positive is Debtor, negative is Creditor, and zero is Cleared.
4. Confirm Registry and Admission Officer cannot access the page.
5. Export the filtered result as CSV, Excel and PDF.

## Institution-wide matriculation sequence

1. Add a unique code to each department and enable automatic matriculation for the test session under Admission Settings.
2. Open `/staff/admissions/matriculation` and generate numbers for eligible applicants in two different departments.
3. Confirm an acceptance-paid applicant who is not admitted appears as **Awaiting Admission**, without a Generate action.
4. Confirm an admitted applicant who has not paid the compulsory fee appears as **Awaiting Compulsory Fee**.
5. Confirm the final sequence continues from `001` to `002` and never resets for the second department.
6. Repeat an allocation request and confirm it returns the existing assignment without consuming another number.

## Announcement and document corrections

1. Publish a targeted Applicant announcement and confirm its dashboard card, urgent modal, bell notification, email delivery and `/applicant/announcements` entry.
2. Edit the announcement and confirm the revised content appears.
3. Repeat with Student and Both audiences using `/student/announcements`.
4. Create a document using the rich-text controls, text watermark and validated PNG/JPEG watermark upload.
5. Verify Preview, Sample PDF, the complete institutional address and version-preserving publication.

## 1. Regression baseline and navigation

1. Log in separately as Admin, Registry, Admission Officer, Applicant and Student.
2. Open every visible sidebar link relevant to that role.
3. Confirm existing working Student, result, attendance, payment and application pages still open.
4. Confirm Admin, Registry and Admission Officer see Admissions; unrelated placeholder links are absent.
5. Enter an unauthorized staff URL manually and confirm a 403 response.

## 2. Admission criteria

1. Open **Admissions → Admission Criteria**.
2. Choose a session/application type and create a 55% criterion with maximum score 400.
3. Require English Language and Mathematics at C6.
4. Add programme-, department- and school-level rules and confirm programme rules take precedence.
5. Edit a rule and provide a reason; verify its audit entry.
6. Test applications with no score, a low score, the exact cut-off, a high score and missing subjects.

## 3. Admission and bulk admission

1. Open **Manage Admissions** and exercise all filters.
2. Admit one eligible test applicant and confirm the status, notification and email-delivery row.
3. Select eligible and ineligible rows together and use **Admit selected**.
4. Confirm eligible applications are processed and invalid ones are skipped without partial corruption.
5. Repeat an admission request and confirm no duplicate decision or email notification is created.

## 4. Revocation

1. Revoke an admitted applicant who has not paid acceptance and record a reason.
2. Confirm their admission letter becomes invalid and the portal shows the revocation.
3. Confirm the page explicitly says refunds are handled manually by Bursary.
4. Try to revoke an applicant with paid acceptance; confirm rejection.
5. Try to revoke an applicant with a Student transition; confirm rejection.

## 5. Applicant corrections

1. Open **Edit** beside a test applicant.
2. Correct names and select a valid school/department/programme combination.
3. Enter a reason and save; confirm the before/after audit history.
4. Attempt an invalid hierarchy and confirm rejection.
5. Replace the passport with JPG/PNG, then try a renamed non-image file and a file over 5 MB.
6. Confirm Student records cannot be edited from this workflow.

## 6. Notifications and SMTP

1. Add SMTP values to `.env` and restart the portal.
2. Admit a test applicant and check the bell, notification page and mailbox.
3. Stop or misconfigure SMTP, admit another test applicant and confirm admission still succeeds.
4. Open **Email Deliveries**, correct SMTP and retry the failed delivery.

## 7. Admission settings, templates, letter and QR

1. As Admin, require paid acceptance before printing.
2. Confirm direct letter access returns 403 before payment and succeeds after confirmed payment.
3. Disable the requirement for a test application type and confirm printing is allowed.
4. Create, preview through a test issue, and publish an Admission Letter template.
5. Download the letter, confirm fields and scan the QR.
6. Publish a new template version; confirm an already issued document retains its stored template version.
7. Revoke an eligible offer and confirm the same QR reports `REVOKED`.

## 8. Screening

1. Create school, department, programme and individual schedules.
2. Publish them and confirm precedence: individual → programme → department → school.
3. As the applicant, open Screening Schedule, download the PDF and scan its QR.
4. Cancel/reschedule a schedule and confirm the status and audit history.

## 9. Announcements

1. Publish applicant, student and combined announcements with future/expiry dates.
2. Confirm only active applicant announcements appear on the Applicant dashboard.
3. Confirm expired and draft announcements do not appear.

## 10. Payments and exports

1. Open All/General, Application Fee and Acceptance Fee reports.
2. Filter PAID, PENDING, FAILED and CANCELLED records by date, type and search text.
3. Download CSV, Excel and PDF; compare row counts, statuses and totals with the filtered screen.
4. Confirm raw provider metadata and secrets are not exported.

## 11. Applicant-to-Student transition and duplicate protection

1. Test acceptance first/compulsory later, compulsory first/acceptance later, and both close together.
2. Confirm Student access is granted only after both payments are confirmed.
3. Replay the same compulsory callback and run two callbacks concurrently.
4. Confirm one transition, one Student profile and one Student role membership exist.
5. Use the portal chooser to enter both Applicant and Student portals.
6. Confirm Applicant history remains available.
7. Matriculation stays `PENDING_MATRICULATION` until management approves the final sequence scope.

## 12. Final security regression

Test cross-applicant IDs, direct restricted URLs, missing CSRF tokens, template scripts/event handlers, forged image files, repeated callbacks, invalid QR tokens and spreadsheet-formula input. Then repeat the original application, payment, results and Student workflows.

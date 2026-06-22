import { pool } from "../../core/db.js";
import {
  getOpenApplicationFormBySlug,
  loadApplicantProfile,
} from "../../services/applicationPortalService.js";
import {
  loadApplicationProgress,
} from "../../services/applicationPaymentService.js";

function parseStoredFormData(value) {
  if (
    value &&
    typeof value === "object" &&
    !Buffer.isBuffer(value)
  ) {
    return value;
  }

  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(String(value));

    return parsed &&
      typeof parsed === "object"
      ? parsed
      : {};
  } catch {
    return {};
  }
}

async function loadCurrentDocuments(applicationId) {
  const [rows] = await pool.query(
    `
      SELECT
        id,
        applicant_application_id,
        document_type,
        document_label,
        original_filename,
        mime_type,
        file_extension,
        size_bytes,
        created_at
      FROM application_documents
      WHERE applicant_application_id = ?
        AND is_current = 1
        AND deleted_at IS NULL
      ORDER BY created_at ASC, id ASC
    `,
    [applicationId],
  );

  return rows || [];
}

async function loadOwnedApplication(
  applicationId,
  applicantUserId,
) {
  const [rows] = await pool.query(
    `
      SELECT
        aa.id,
        aa.application_form_id,
        aa.applicant_user_id,
        aa.application_number,
        aa.application_payment_status,
        aa.programme_choice,
        aa.form_data,
        aa.status AS application_status,
        aa.created_at,
        aa.submitted_at,
        af.title AS application_title,
        af.slug AS application_slug,
        af.category,
        s.name AS session_name
      FROM applicant_applications aa
      INNER JOIN application_forms af
        ON af.id = aa.application_form_id
      LEFT JOIN sessions s
        ON s.id = af.session_id
      WHERE aa.id = ?
        AND aa.applicant_user_id = ?
      LIMIT 1
    `,
    [
      applicationId,
      applicantUserId,
    ],
  );

  return rows?.[0] || null;
}

function validateApplicationForSubmission({
  formData,
  applicationType,
  documents,
}) {
  const errors = [];

  const details =
    formData?.application_details &&
    typeof formData.application_details === "object"
      ? formData.application_details
      : {};

  const personal =
    details.personal &&
    typeof details.personal === "object"
      ? details.personal
      : {};

  const choice =
    details.programme_choice &&
    typeof details.programme_choice === "object"
      ? details.programme_choice
      : {};

  const olevel =
    details.olevel &&
    typeof details.olevel === "object"
      ? details.olevel
      : {};

  const requiredPersonalFields = [
    ["first_name", "First name"],
    ["surname", "Surname"],
    ["gender", "Gender"],
    ["date_of_birth", "Date of birth"],
    ["email", "Email address"],
    ["phone", "Phone number"],
    ["state_of_origin", "State of origin"],
    ["lga", "Local Government Area"],
    [
      "residential_address",
      "Residential address",
    ],
  ];

  for (
    const [field, label]
    of requiredPersonalFields
  ) {
    if (!String(personal[field] || "").trim()) {
      errors.push(`${label} is incomplete.`);
    }
  }

  if (
    !Number(choice.school_id || 0) ||
    !String(choice.school_name || "").trim()
  ) {
    errors.push("School selection is incomplete.");
  }

  if (
    !Number(choice.department_id || 0) ||
    !String(choice.department_name || "").trim()
  ) {
    errors.push("Department selection is incomplete.");
  }

  if (
    !Number(choice.programme_id || 0) ||
    !String(choice.programme_name || "").trim()
  ) {
    errors.push("Programme selection is incomplete.");
  }

  const sittings = Array.isArray(olevel.sittings)
    ? olevel.sittings
    : [];

  const sittingCount = Math.max(
    1,
    Math.min(
      2,
      Number(
        olevel.sitting_count ||
        sittings.length ||
        1,
      ),
    ),
  );

  const selectedSittings =
    sittings.slice(0, sittingCount);

  if (!selectedSittings.length) {
    errors.push(
      "O'Level result details are incomplete.",
    );
  }

  const validSubjects = new Set();
  let hasEnglish = false;
  let hasMathematics = false;

  for (const sitting of selectedSittings) {
    if (
      !String(
        sitting?.examination_type || "",
      ).trim()
    ) {
      errors.push(
        "O'Level examination type is incomplete.",
      );
    }

    if (
      !String(
        sitting?.examination_number || "",
      ).trim()
    ) {
      errors.push(
        "O'Level examination number is incomplete.",
      );
    }

    if (
      !String(
        sitting?.examination_year || "",
      ).trim()
    ) {
      errors.push(
        "O'Level examination year is incomplete.",
      );
    }

    const subjects =
      sitting?.subjects &&
      typeof sitting.subjects === "object"
        ? sitting.subjects
        : {};

    for (
      const [subjectKey, rawGrade]
      of Object.entries(subjects)
    ) {
      const grade = String(
        rawGrade || "",
      ).trim().toUpperCase();

      if (!grade || grade === "ABS") {
        continue;
      }

      const normalizedSubject = String(
        subjectKey || "",
      )
        .toLowerCase()
        .replace(/[^a-z]/g, "");

      validSubjects.add(normalizedSubject);

      if (
        normalizedSubject.includes("english")
      ) {
        hasEnglish = true;
      }

      if (
        normalizedSubject.includes(
          "mathematics",
        ) ||
        normalizedSubject === "maths"
      ) {
        hasMathematics = true;
      }
    }
  }

  if (validSubjects.size < 5) {
    errors.push(
      "At least five valid O'Level subjects are required.",
    );
  }

  if (!hasEnglish) {
    errors.push(
      "English Language must be included in the O'Level result.",
    );
  }

  if (!hasMathematics) {
    errors.push(
      "Mathematics must be included in the O'Level result.",
    );
  }

  const uploadedTypes = new Set(
    (Array.isArray(documents) ? documents : [])
      .map((document) =>
        String(
          document.document_type || "",
        ).toUpperCase(),
      ),
  );

  const requiredDocuments = [
    ["PASSPORT", "Passport Photograph"],
    ["OLEVEL_RESULT", "O'Level Result"],
    [
      "BIRTH_CERTIFICATE",
      "Birth Certificate or Declaration of Age",
    ],
    [
      "LGA_IDENTIFICATION",
      "LGA or State Identification",
    ],
  ];

  if (
    String(applicationType || "")
      .toUpperCase() === "UTME"
  ) {
    requiredDocuments.push([
      "JAMB_RESULT",
      "JAMB Result or Registration Slip",
    ]);
  }

  for (
    const [documentType, label]
    of requiredDocuments
  ) {
    if (!uploadedTypes.has(documentType)) {
      errors.push(`${label} has not been uploaded.`);
    }
  }

  return Array.from(new Set(errors));
}

// POST /applicant/applications/:slug/submit
export async function submitApplication(
  req,
  res,
  next,
) {
  try {
    const form = await getOpenApplicationFormBySlug(
      req.params.slug,
    );

    if (!form) {
      req.flash?.(
        "error",
        "This application is not currently available.",
      );

      return res.redirect("/applicant/dashboard");
    }

    const publicUser = await loadApplicantProfile(
      req.session?.publicUser || {},
    );

    if (!publicUser?.id) {
      return res.redirect("/login");
    }

    const progress = await loadApplicationProgress(
      form.id,
      publicUser.id,
    );

    if (!progress) {
      req.flash?.(
        "error",
        "Start the application before submitting it.",
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}`,
      );
    }

    const currentStatus = String(
      progress.status || "",
    ).toUpperCase();

    if (
      [
        "SUBMITTED",
        "UNDER_REVIEW",
        "ADMITTED",
        "REJECTED",
        "WITHDRAWN",
      ].includes(currentStatus)
    ) {
      req.flash?.(
        "error",
        "This application has already been submitted and can no longer be changed.",
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}/preview`,
      );
    }

    const paymentStatus = String(
      progress.application_payment_status || "",
    ).toUpperCase();

    if (
      !["PAID", "NOT_REQUIRED"].includes(
        paymentStatus,
      )
    ) {
      req.flash?.(
        "error",
        "Complete the application payment before final submission.",
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}`,
      );
    }

    const declarationAccepted =
      String(
        req.body?.declaration_accepted || "",
      ).toLowerCase() === "yes";

    if (!declarationAccepted) {
      req.flash?.(
        "error",
        "You must accept the applicant declaration before final submission.",
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}/preview`,
      );
    }

    const formData =
      progress.form_data_object &&
      typeof progress.form_data_object === "object"
        ? progress.form_data_object
        : parseStoredFormData(
            progress.form_data,
          );

    const documents =
      await loadCurrentDocuments(progress.id);

    const validationErrors =
      validateApplicationForSubmission({
        formData,
        applicationType:
          form.category ||
          formData?.application_details
            ?.application_type,
        documents,
      });

    if (validationErrors.length) {
      req.flash?.(
        "error",
        `Final submission could not be completed: ${validationErrors.join(
          " ",
        )}`,
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}/preview`,
      );
    }

    const submissionData = {
      ...formData,
      application_details: {
        ...(formData.application_details || {}),
        declaration: {
          accepted: true,
          accepted_at:
            new Date().toISOString(),
          applicant_user_id:
            Number(publicUser.id),
          statement:
            "I confirm that the information and documents supplied in this application are complete and accurate.",
        },
      },
    };

    const [result] = await pool.query(
      `
        UPDATE applicant_applications
        SET
          form_data = ?,
          status = 'SUBMITTED',
          submitted_at = COALESCE(
            submitted_at,
            NOW()
          )
        WHERE id = ?
          AND applicant_user_id = ?
          AND status IN (
            'DRAFT',
            'IN_PROGRESS'
          )
      `,
      [
        JSON.stringify(submissionData),
        progress.id,
        publicUser.id,
      ],
    );

    if (!result.affectedRows) {
      req.flash?.(
        "error",
        "The application could not be submitted because its status changed. Reload it and try again.",
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}/preview`,
      );
    }

    req.flash?.(
      "success",
      "Your application has been submitted successfully. You can now print the official application copy.",
    );

    return res.redirect(
      `/applicant/applications/${encodeURIComponent(
        form.slug,
      )}/preview`,
    );
  } catch (error) {
    next(error);
  }
}

// GET /applicant/applications/:applicationId/print
export async function printApplication(
  req,
  res,
  next,
) {
  try {
    const applicantUserId = Number(
      req.session?.publicUser?.id || 0,
    );

    const applicationId = Number(
      req.params.applicationId || 0,
    );

    if (!applicantUserId || !applicationId) {
      return res.status(400).send(
        "Invalid application print request.",
      );
    }

    const publicUser = await loadApplicantProfile(
      req.session?.publicUser || {},
    );

    const application =
      await loadOwnedApplication(
        applicationId,
        applicantUserId,
      );

    if (!application) {
      return res.status(404).send(
        "Application not found.",
      );
    }

    const formData =
      parseStoredFormData(
        application.form_data,
      );

    const applicationDocuments =
      await loadCurrentDocuments(
        application.id,
      );

    return res.render(
      "applications/applicant-print",
      {
        layout: false,
        title:
          `${application.application_title} - ` +
          "Print Application",
        application,
        applicantProfile: publicUser,
        formData,
        applicationDocuments,
      },
    );
  } catch (error) {
    next(error);
  }
}

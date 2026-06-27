// app/web/controllers/applicant.controller.js
import { pool } from '../../core/db.js';
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import {
  getApplicationDocumentConfiguration,
} from "../middleware/applicationDocumentUpload.js";
import {
  getOpenApplicationFormBySlug,
  getApplicationFormBySlug,
  checkApplicantPrerequisite,
  loadApplicantProfile,
  verifyApplicantReference,
} from "../../services/applicationPortalService.js";
import {
  startOrResumeApplication,
  loadApplicationProgress,
} from "../../services/applicationPaymentService.js";
import {
  listAcceptanceApplications,
  startOrResumeAcceptancePayment,
} from "../../services/applicationAcceptancePaymentService.js";



const APPLICATION_DOCUMENT_ROOT = path.resolve(
  "app/uploads/applications",
);

async function loadCurrentApplicationDocuments(
  applicationId,
) {
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
      ORDER BY
        FIELD(
          document_type,
          'PASSPORT',
          'JAMB_RESULT',
          'OLEVEL_RESULT',
          'BIRTH_CERTIFICATE',
          'LGA_IDENTIFICATION',
          'OTHER'
        ),
        created_at DESC
    `,
    [applicationId],
  );

  return rows || [];
}

function safeApplicationStoragePath(storagePath) {
  const absolutePath = path.resolve(
    String(storagePath || ""),
  );

  const allowedPrefix =
    `${APPLICATION_DOCUMENT_ROOT}${path.sep}`;

  if (
    absolutePath !== APPLICATION_DOCUMENT_ROOT &&
    !absolutePath.startsWith(allowedPrefix)
  ) {
    return null;
  }

  return absolutePath;
}


// Applicant dashboard -> render your AdminLTE applicant page
export function dashboard(req, res) {
  res.render('pages/applicant', { title: 'Applicant Dashboard', pageTitle: 'Dashboard' });
}


// GET /applicant/applications/:slug
export async function applicationDetails(req, res, next) {
  try {
    const form = await getOpenApplicationFormBySlug(
      req.params.slug,
    );

    if (!form) {
      return res.status(404).render("pages/denied", {
        layout: "layouts/adminlte",
        title: "Application Not Available",
        pageTitle: "Application Not Available",
        reason:
          "This application is closed, inactive, outside its application window or does not exist.",
        homeHref: "/applicant/dashboard",
        _role: "applicant",
        _user: {
          full_name:
            req.session?.publicUser?.full_name ||
            req.session?.publicUser?.username ||
            "Applicant",
        },
        user:
          res.locals.user ||
          req.session?.publicUser ||
          null,
        allowedModules: [],
        currentPath: req.originalUrl || req.path || "",
      });
    }

    const publicUser = await loadApplicantProfile(
      req.session?.publicUser || {},
    );

    const eligibility = await checkApplicantPrerequisite(
      form,
      publicUser,
    );

    const progress = publicUser?.id
      ? await loadApplicationProgress(form.id, publicUser.id)
      : null;

    return res.render(
      "applications/applicant-application",
      {
        layout: "layouts/adminlte",
        title: form.title,
        pageTitle: form.title,
        _role: "applicant",
        _user: {
          full_name:
            publicUser.full_name ||
            [
              publicUser.first_name,
              publicUser.middle_name,
              publicUser.last_name,
            ].filter(Boolean).join(" ") ||
            publicUser.username ||
            "Applicant",
        },
        user: res.locals.user || publicUser || null,
        allowedModules: [],
        currentPath: req.originalUrl || req.path || "",
        form,
        eligibility,
        progress,
      },
    );
  } catch (error) {
    next(error);
  }
}


// POST /applicant/applications/:slug/verify-prerequisite
export async function verifyApplicationPrerequisite(
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

    const result = await verifyApplicantReference(
      form,
      publicUser,
      req.body?.jamb_registration_number,
    );

    if (!result.ok) {
      req.flash?.("error", result.message);

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}#eligibility`,
      );
    }

    req.flash?.("success", result.message);

    return res.redirect(
      `/applicant/applications/${encodeURIComponent(
        form.slug,
      )}#eligibility`,
    );
  } catch (error) {
    next(error);
  }
}


// POST /applicant/applications/:slug/start
export async function startApplication(req, res, next) {
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
      req.flash?.(
        "error",
        "Your applicant account could not be identified.",
      );

      return res.redirect("/applicant/dashboard");
    }

    const eligibility = await checkApplicantPrerequisite(
      form,
      publicUser,
    );

    if (!eligibility.eligible) {
      req.flash?.(
        "error",
        "Complete the prerequisite verification before starting this application.",
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}#eligibility`,
      );
    }

    const result = await startOrResumeApplication({
      form,
      applicant: publicUser,
      verifiedRecord: eligibility.verified_record || null,
    });

    if (result.kind === "PAYMENT") {
      return res.redirect(
        `/payment/application/${encodeURIComponent(
          result.invoice.order_id,
        )}`,
      );
    }

    return res.redirect(
      `/applicant/applications/${encodeURIComponent(
        form.slug,
      )}/form`,
    );
  } catch (error) {
    next(error);
  }
}

// GET /applicant/applications/:slug/form
export async function applicationForm(req, res, next) {
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

    const progress = await loadApplicationProgress(
      form.id,
      publicUser.id,
    );

    if (!progress) {
      req.flash?.(
        "error",
        "Start the application before opening the form.",
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}`,
      );
    }

    const paymentStatus = String(
      progress.application_payment_status || "",
    ).toUpperCase();

    if (!["PAID", "NOT_REQUIRED"].includes(paymentStatus)) {
      req.flash?.(
        "error",
        "Complete the application payment before opening the form.",
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}`,
      );
    }

    const [schools] = await pool.query(
      `
        SELECT id, name
        FROM schools
        ORDER BY name ASC
      `,
    );

    const [departments] = await pool.query(
      `
        SELECT id, name, school_id
        FROM departments
        ORDER BY name ASC
      `,
    );

    const [programmes] = await pool.query(
      `
        SELECT id, name, school_id, department_id
        FROM programmes
        ORDER BY name ASC
      `,
    );

    const applicationDocuments =
      await loadCurrentApplicationDocuments(
        progress.id,
      );

    const validationFieldFlash =
      req.flash?.("applicationValidationFields") || [];

    let validationFields = [];
      let validationMessages = {};

    try {
      const rawValidationFields =
        Array.isArray(validationFieldFlash)
          ? validationFieldFlash[0]
          : validationFieldFlash;

      validationFields = rawValidationFields
        ? JSON.parse(rawValidationFields)
        : [];
    } catch {
      validationFields = [];
    }

      const validationMessageFlash =
        req.flash?.("applicationValidationMessages") || [];

      try {
        const rawValidationMessages =
          Array.isArray(validationMessageFlash)
            ? validationMessageFlash[0]
            : validationMessageFlash;

        validationMessages = rawValidationMessages
          ? JSON.parse(rawValidationMessages)
          : {};
      } catch {
        validationMessages = {};
      }

    return res.render(
      "applications/applicant-form",
      {
        layout: "layouts/adminlte",
        title: form.title,
        pageTitle: form.title,
        _role: "applicant",
        _user: {
          full_name:
            [
              publicUser.first_name,
              publicUser.middle_name,
              publicUser.last_name,
            ].filter(Boolean).join(" ") ||
            publicUser.username ||
            "Applicant",
        },
        user: res.locals.user || publicUser,
        allowedModules: [],
        currentPath: req.originalUrl || req.path || "",
        form,
        progress,
        formData: progress.form_data_object || {},
        applicantProfile: publicUser,
        schools: schools || [],
        departments: departments || [],
        programmes: programmes || [],
          applicationDocuments,
        validationFields,
        validationMessages,
      },
    );
  } catch (error) {
    next(error);
  }
}

// POST /applicant/applications/:slug/form
export async function saveApplicationForm(req, res, next) {
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

    const progress = await loadApplicationProgress(
      form.id,
      publicUser.id,
    );

    if (!progress) {
      req.flash?.("error", "Application record not found.");

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}`,
      );
    }

    const paymentStatus = String(
      progress.application_payment_status || "",
    ).toUpperCase();

    if (!["PAID", "NOT_REQUIRED"].includes(paymentStatus)) {
      req.flash?.(
        "error",
        "Complete payment before continuing the application.",
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}`,
      );
    }

    if (
      ["SUBMITTED", "ADMITTED", "REJECTED"].includes(
        String(progress.status || "").toUpperCase(),
      )
    ) {
      req.flash?.(
        "error",
        "This application can no longer be edited.",
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}/form`,
      );
    }

    const existingData =
      progress.form_data_object &&
      typeof progress.form_data_object === "object"
        ? progress.form_data_object
        : {};

    const existingDetails =
      existingData.application_details &&
      typeof existingData.application_details === "object"
        ? existingData.application_details
        : {};

    const existingPersonal =
      existingDetails.personal &&
      typeof existingDetails.personal === "object"
        ? existingDetails.personal
        : {};

    const existingChoice =
      existingDetails.programme_choice &&
      typeof existingDetails.programme_choice === "object"
        ? existingDetails.programme_choice
        : {};

    const verifiedCandidate =
      existingData.verified_prerequisite &&
      typeof existingData.verified_prerequisite === "object"
        ? existingData.verified_prerequisite
        : {};

    const hasVerifiedCandidate = Boolean(
      verifiedCandidate.id ||
        verifiedCandidate.candidate_reference,
    );

    const body = req.body || {};

    const cleanValue = (value) =>
      String(value ?? "").trim();

    const firstAvailable = (...values) => {
      for (const value of values) {
        const cleaned = cleanValue(value);

        if (cleaned) return cleaned;
      }

      return "";
    };

      const existingOLevel =
        existingDetails.olevel &&
        typeof existingDetails.olevel === "object"
          ? existingDetails.olevel
          : {
              sitting_count: 1,
              sittings: [],
            };

      const olevelSubjects = [
        "english_language",
        "mathematics",
        "biology",
        "physics",
        "chemistry",
        "economics",
        "agricultural_science",
        "geography",
        "civic_education",
      ];

      const hasOLevelPayload = Object.keys(body).some(
        (key) =>
          key === "olevel_sitting_count" ||
          key.startsWith("sitting_1_") ||
          key.startsWith("sitting_2_"),
      );

      let olevel = existingOLevel;

      if (hasOLevelPayload) {
        const sittingCount =
          cleanValue(body.olevel_sitting_count) === "2"
            ? 2
            : 1;

        const sittings = [];

        for (
          let sittingNumber = 1;
          sittingNumber <= sittingCount;
          sittingNumber += 1
        ) {
          const subjects = {};

          for (const subject of olevelSubjects) {
            subjects[subject] = cleanValue(
              body[
                `sitting_${sittingNumber}_${subject}`
              ],
            ).toUpperCase();
          }

          sittings.push({
            sitting_number: sittingNumber,
            examination_type: cleanValue(
              body[
                `sitting_${sittingNumber}_exam_type`
              ],
            ).toUpperCase(),
            examination_number: cleanValue(
              body[
                `sitting_${sittingNumber}_exam_number`
              ],
            ).toUpperCase(),
            examination_year: cleanValue(
              body[
                `sitting_${sittingNumber}_exam_year`
              ],
            ),
            subjects,
          });
        }

        olevel = {
          sitting_count: sittingCount,
          sittings,
        };
      }

    const schoolId = Number(body.school_id || 0);
    const departmentId = Number(body.department_id || 0);
    const programmeId = Number(body.programme_id || 0);

    let selectedSchool = null;
    let selectedDepartment = null;
    let selectedProgramme = null;

    if (schoolId) {
      const [schoolRows] = await pool.query(
        `
          SELECT id, name
          FROM schools
          WHERE id = ?
          LIMIT 1
        `,
        [schoolId],
      );

      selectedSchool = schoolRows?.[0] || null;

      if (!selectedSchool) {
        req.flash?.(
          "error",
          "The selected school could not be found.",
        );

        return res.redirect(
          `/applicant/applications/${encodeURIComponent(
            form.slug,
          )}/form`,
        );
      }
    }

    if (departmentId) {
      const [departmentRows] = await pool.query(
        `
          SELECT
            d.id,
            d.name,
            d.school_id,
            s.name AS school_name
          FROM departments d
          INNER JOIN schools s
            ON s.id = d.school_id
          WHERE d.id = ?
          LIMIT 1
        `,
        [departmentId],
      );

      selectedDepartment = departmentRows?.[0] || null;

      if (
        !selectedDepartment ||
        (
          schoolId &&
          Number(selectedDepartment.school_id) !== schoolId
        )
      ) {
        req.flash?.(
          "error",
          "The selected department does not belong to the selected school.",
        );

        return res.redirect(
          `/applicant/applications/${encodeURIComponent(
            form.slug,
          )}/form`,
        );
      }
    }

    if (programmeId) {
      const [programmeRows] = await pool.query(
        `
          SELECT
            p.id,
            p.name,
            p.school_id,
            p.department_id,
            d.name AS department_name,
            s.name AS school_name
          FROM programmes p
          INNER JOIN departments d
            ON d.id = p.department_id
          INNER JOIN schools s
            ON s.id = d.school_id
          WHERE p.id = ?
          LIMIT 1
        `,
        [programmeId],
      );

      selectedProgramme = programmeRows?.[0] || null;

      if (
        !selectedProgramme ||
        (
          schoolId &&
          Number(selectedProgramme.school_id) !== schoolId
        ) ||
        (
          departmentId &&
          Number(selectedProgramme.department_id) !==
            departmentId
        )
      ) {
        req.flash?.(
          "error",
          "The selected programme does not belong to the selected department.",
        );

        return res.redirect(
          `/applicant/applications/${encodeURIComponent(
            form.slug,
          )}/form`,
        );
      }
    }

    const profileUsername = cleanValue(
      publicUser.username,
    );

    const profileEmail = profileUsername.includes("@")
      ? profileUsername
      : "";

    const applicationType = cleanValue(
      form.category,
    ).toUpperCase();

    const personalDetails = {
      first_name: hasVerifiedCandidate
        ? cleanValue(verifiedCandidate.first_name)
        : firstAvailable(
            body.first_name,
            existingPersonal.first_name,
            publicUser.first_name,
          ),

      middle_name: hasVerifiedCandidate
        ? cleanValue(verifiedCandidate.middle_name)
        : firstAvailable(
            body.middle_name,
            existingPersonal.middle_name,
            publicUser.middle_name,
          ),

      surname: hasVerifiedCandidate
        ? cleanValue(verifiedCandidate.surname)
        : firstAvailable(
            body.surname,
            existingPersonal.surname,
            publicUser.last_name,
          ),

      gender: hasVerifiedCandidate
        ? cleanValue(verifiedCandidate.gender)
        : firstAvailable(
            body.gender,
            existingPersonal.gender,
          ),

      date_of_birth: firstAvailable(
        body.date_of_birth,
        existingPersonal.date_of_birth,
      ),

      email: firstAvailable(
        body.email,
        existingPersonal.email,
        profileEmail,
      ),

      phone: firstAvailable(
        body.phone,
        existingPersonal.phone,
        publicUser.phone,
      ),

      state_of_origin: hasVerifiedCandidate
        ? cleanValue(
            verifiedCandidate.state_of_origin,
          )
        : firstAvailable(
            body.state_of_origin,
            existingPersonal.state_of_origin,
            publicUser.state_of_origin,
          ),

      // LGA is deliberately editable, including for
      // applicants whose other details came from JAMB.
      lga: firstAvailable(
        body.lga,
        existingPersonal.lga,
        verifiedCandidate.lga,
        publicUser.lga,
      ),

      residential_address: firstAvailable(
        body.residential_address,
        existingPersonal.residential_address,
      ),

      jamb_registration_number:
        applicationType === "UTME"
          ? (
              hasVerifiedCandidate
                ? cleanValue(
                    verifiedCandidate.candidate_reference,
                  )
                : firstAvailable(
                    body.jamb_registration_number,
                    existingPersonal
                      .jamb_registration_number,
                  )
            )
          : "",

      jamb_total_score:
        applicationType === "UTME"
          ? (
              hasVerifiedCandidate
                ? cleanValue(
                    verifiedCandidate.jamb_total_score,
                  )
                : firstAvailable(
                    body.jamb_total_score,
                    existingPersonal.jamb_total_score,
                  )
            )
          : "",
    };

    const programmeChoice = {
      school_id:
        schoolId ||
        Number(existingChoice.school_id || 0) ||
        null,

      school_name:
        cleanValue(selectedSchool?.name) ||
        cleanValue(selectedDepartment?.school_name) ||
        cleanValue(selectedProgramme?.school_name) ||
        (
          Number(existingChoice.school_id || 0) ===
          schoolId
            ? cleanValue(existingChoice.school_name)
            : ""
        ),

      department_id:
        departmentId ||
        Number(existingChoice.department_id || 0) ||
        null,

      department_name:
        cleanValue(selectedDepartment?.name) ||
        cleanValue(selectedProgramme?.department_name) ||
        (
          Number(existingChoice.department_id || 0) ===
          departmentId
            ? cleanValue(
                existingChoice.department_name,
              )
            : ""
        ),

      programme_id:
        programmeId ||
        Number(existingChoice.programme_id || 0) ||
        null,

      programme_name:
        cleanValue(selectedProgramme?.name) ||
        (
          Number(existingChoice.programme_id || 0) ===
          programmeId
            ? cleanValue(existingChoice.programme_name)
            : ""
        ),
    };

    const requestedAction = cleanValue(
      body.action,
    ).toLowerCase();

    const validationErrors = [];
    const validationFields = [];
      const validationMessages = {};

      const addValidationError = (field, message) => {
        validationFields.push(field);
        validationErrors.push(message);

        if (!validationMessages[field]) {
          validationMessages[field] = message;
        }
      };

    const requiresCompleteValidation = [
      "preview",
      "submit",
    ].includes(requestedAction);

    if (requiresCompleteValidation) {
      const namePattern =
        /^[A-Za-zÀ-ÖØ-öø-ÿ' -]{2,60}$/;

      const locationPattern =
        /^[A-Za-zÀ-ÖØ-öø-ÿ'.() -]{2,80}$/;

      const emailPattern =
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      const jambPattern =
        /^[A-Za-z0-9/-]{6,30}$/;

      const phoneDigits =
        personalDetails.phone.replace(/\D+/g, "");

      if (!personalDetails.first_name) {
        addValidationError(
          "first_name",
          "First name is required.",
        );
      } else if (
        !namePattern.test(personalDetails.first_name)
      ) {
        addValidationError(
          "first_name",
          "First name contains invalid characters.",
        );
      }

      if (
        personalDetails.middle_name &&
        !namePattern.test(personalDetails.middle_name)
      ) {
        addValidationError(
          "middle_name",
          "Middle name contains invalid characters.",
        );
      }

      if (!personalDetails.surname) {
        addValidationError(
          "surname",
          "Surname is required.",
        );
      } else if (
        !namePattern.test(personalDetails.surname)
      ) {
        addValidationError(
          "surname",
          "Surname contains invalid characters.",
        );
      }

      if (!personalDetails.gender) {
        addValidationError(
          "gender",
          "Gender is required.",
        );
      } else if (
        !["male", "female", "m", "f"].includes(
          personalDetails.gender.toLowerCase(),
        )
      ) {
        addValidationError(
          "gender",
          "Select a valid gender.",
        );
      }

      if (!personalDetails.date_of_birth) {
        addValidationError(
          "date_of_birth",
          "Date of birth is required.",
        );
      } else {
        const birthDate = new Date(
          `${personalDetails.date_of_birth}T00:00:00`,
        );

        const today = new Date();

        if (
          Number.isNaN(birthDate.getTime()) ||
          birthDate > today
        ) {
          addValidationError(
            "date_of_birth",
            "Enter a valid date of birth.",
          );
        }
      }

      if (!personalDetails.email) {
        addValidationError(
          "email",
          "Email address is required.",
        );
      } else if (
        !emailPattern.test(personalDetails.email)
      ) {
        addValidationError(
          "email",
          "Enter a valid email address.",
        );
      }

      if (!personalDetails.phone) {
        addValidationError(
          "phone",
          "Phone number is required.",
        );
      } else if (
        phoneDigits.length < 7 ||
        phoneDigits.length > 15
      ) {
        addValidationError(
          "phone",
          "Enter a valid phone number.",
        );
      }

      if (!personalDetails.state_of_origin) {
        addValidationError(
          "state_of_origin",
          "State of origin is required.",
        );
      } else if (
        !locationPattern.test(
          personalDetails.state_of_origin,
        )
      ) {
        addValidationError(
          "state_of_origin",
          "Enter a valid state of origin.",
        );
      }

      if (!personalDetails.lga) {
        addValidationError(
          "lga",
          "Local Government Area is required.",
        );
      } else if (
        !locationPattern.test(personalDetails.lga)
      ) {
        addValidationError(
          "lga",
          "Enter a valid Local Government Area.",
        );
      }

      if (
        !personalDetails.residential_address ||
        personalDetails.residential_address.length < 10
      ) {
        addValidationError(
          "residential_address",
          "Enter a complete residential address.",
        );
      } else if (
        personalDetails.residential_address.length > 250
      ) {
        addValidationError(
          "residential_address",
          "Residential address must not exceed 250 characters.",
        );
      }

      if (!programmeChoice.school_id) {
        addValidationError(
          "school_id",
          "Select a school.",
        );
      }

      if (!programmeChoice.department_id) {
        addValidationError(
          "department_id",
          "Select a department.",
        );
      }

      if (!programmeChoice.programme_id) {
        addValidationError(
          "programme_id",
          "Select a programme.",
        );
      }

        const allowedOLevelExamTypes = new Set([
          "WAEC",
          "NECO",
          "NABTEB",
        ]);

        const allowedOLevelGrades = new Set([
          "A1",
          "B2",
          "B3",
          "C4",
          "C5",
          "C6",
          "D7",
          "E8",
          "F9",
          "ABS",
        ]);

        const selectedSittingCount =
          Number(olevel.sitting_count) === 2
            ? 2
            : 1;

        const selectedSittings =
          Array.isArray(olevel.sittings)
            ? olevel.sittings.slice(
                0,
                selectedSittingCount,
              )
            : [];

        const completedOLevelSubjects = new Set();
        const currentYear = new Date().getFullYear();

        for (
          let sittingNumber = 1;
          sittingNumber <= selectedSittingCount;
          sittingNumber += 1
        ) {
          const sitting =
            selectedSittings[sittingNumber - 1] || {};

          const examType = cleanValue(
            sitting.examination_type,
          ).toUpperCase();

          const examNumber = cleanValue(
            sitting.examination_number,
          ).toUpperCase();

          const examYear = Number(
            sitting.examination_year,
          );

          const examTypeField =
            `sitting_${sittingNumber}_exam_type`;

          const examNumberField =
            `sitting_${sittingNumber}_exam_number`;

          const examYearField =
            `sitting_${sittingNumber}_exam_year`;

          if (!allowedOLevelExamTypes.has(examType)) {
            addValidationError(
              examTypeField,
              `Select a valid examination type for ${
                sittingNumber === 1
                  ? "the first sitting"
                  : "the second sitting"
              }.`,
            );
          }

          if (
            !examNumber ||
            !/^[A-Za-z0-9/-]{5,30}$/.test(
              examNumber,
            )
          ) {
            addValidationError(
              examNumberField,
              `Enter a valid examination number for ${
                sittingNumber === 1
                  ? "the first sitting"
                  : "the second sitting"
              }.`,
            );
          }

          if (
            !Number.isInteger(examYear) ||
            examYear < 1980 ||
            examYear > currentYear
          ) {
            addValidationError(
              examYearField,
              `Select a valid examination year for ${
                sittingNumber === 1
                  ? "the first sitting"
                  : "the second sitting"
              }.`,
            );
          }

          const subjects =
            sitting.subjects &&
            typeof sitting.subjects === "object"
              ? sitting.subjects
              : {};

          for (const subject of olevelSubjects) {
            const grade = cleanValue(
              subjects[subject],
            ).toUpperCase();

            const subjectField =
              `sitting_${sittingNumber}_${subject}`;

            if (
              grade &&
              !allowedOLevelGrades.has(grade)
            ) {
              addValidationError(
                subjectField,
                "Select a valid O'Level grade.",
              );

              continue;
            }

            if (grade && grade !== "ABS") {
              completedOLevelSubjects.add(subject);
            }
          }
        }

        if (completedOLevelSubjects.size < 5) {
          addValidationError(
            "olevel_sitting_count",
            "Enter valid results for at least five distinct O'Level subjects across the selected sitting or sittings.",
          );
        }

        if (
          !completedOLevelSubjects.has(
            "english_language",
          )
        ) {
          addValidationError(
            "sitting_1_english_language",
            "English Language result is required.",
          );
        }

        if (
          !completedOLevelSubjects.has("mathematics")
        ) {
          addValidationError(
            "sitting_1_mathematics",
            "Mathematics result is required.",
          );
        }

      if (applicationType === "UTME") {
        if (
          !personalDetails.jamb_registration_number
        ) {
          addValidationError(
            "jamb_registration_number",
            "JAMB registration number is required.",
          );
        } else if (
          !jambPattern.test(
            personalDetails.jamb_registration_number,
          )
        ) {
          addValidationError(
            "jamb_registration_number",
            "Enter a valid JAMB registration number.",
          );
        }

        const jambScore = Number(
          personalDetails.jamb_total_score,
        );

        if (
          personalDetails.jamb_total_score === "" ||
          !Number.isInteger(jambScore) ||
          jambScore < 0 ||
          jambScore > 400
        ) {
          addValidationError(
            "jamb_total_score",
            "UTME score must be a whole number between 0 and 400.",
          );
        }
      }
    }

    const updatedData = {
      ...existingData,
      application_details: {
        application_type: applicationType,
        personal: personalDetails,
        programme_choice: programmeChoice,
          olevel,
      },
    };

    await pool.query(
      `
        UPDATE applicant_applications
        SET
          programme_choice = ?,
          form_data = ?,
          status = 'IN_PROGRESS',
          submitted_at = NULL
        WHERE id = ?
      `,
      [
        programmeChoice.programme_name || null,
        JSON.stringify(updatedData),
        progress.id,
      ],
    );

    if (validationErrors.length) {
      req.flash?.(
        "error",
        `Please correct the following before previewing or submitting: ${validationErrors.join(
          " ",
        )}`,
      );

      req.flash?.(
        "applicationValidationFields",
        JSON.stringify(
          Array.from(new Set(validationFields)),
        ),
      );

        req.flash?.(
          "applicationValidationMessages",
          JSON.stringify(validationMessages),
        );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}/form`,
      );
    }

      if (requestedAction === "preview") {
        req.flash?.(
          "success",
          "Application details validated successfully. Review all information carefully before final submission.",
        );

        return res.redirect(
          `/applicant/applications/${encodeURIComponent(
            form.slug,
          )}/preview`,
        );
      }

      const attemptedSubmit =
        requestedAction === "submit";

    req.flash?.(
      "success",
      attemptedSubmit
        ? "Your application details were saved. Review and final submission will be available after all required sections are completed."
        : "Application details saved as draft.",
    );

    return res.redirect(
      `/applicant/applications/${encodeURIComponent(
        form.slug,
      )}/form`,
    );
  } catch (error) {
    next(error);
  }
}


// GET /applicant/applications/:slug/preview
export async function applicationPreview(req, res, next) {
  try {
    const form = await getApplicationFormBySlug(
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

    const progress = await loadApplicationProgress(
      form.id,
      publicUser.id,
    );

    if (!progress) {
      req.flash?.(
        "error",
        "Start the application before opening its preview.",
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}`,
      );
    }

    const paymentStatus = String(
      progress.application_payment_status || "",
    ).toUpperCase();

    if (!["PAID", "NOT_REQUIRED"].includes(paymentStatus)) {
      req.flash?.(
        "error",
        "Complete the application payment before previewing the form.",
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}`,
      );
    }

    const formData =
      progress.form_data_object &&
      typeof progress.form_data_object === "object"
        ? progress.form_data_object
        : {};

    const applicationDocuments =
      await loadCurrentApplicationDocuments(
        progress.id,
      );

    const applicationDetails =
      formData.application_details &&
      typeof formData.application_details === "object"
        ? formData.application_details
        : null;

    if (
      !applicationDetails ||
      !applicationDetails.personal ||
      !applicationDetails.programme_choice
    ) {
      req.flash?.(
        "error",
        "Complete and validate the application form before previewing it.",
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}/form`,
      );
    }

    return res.render(
      "applications/applicant-preview",
      {
        layout: "layouts/adminlte",
        title: `${form.title} Preview`,
        pageTitle: "Application Preview",
        _role: "applicant",
        _user: {
          full_name:
            [
              publicUser.first_name,
              publicUser.middle_name,
              publicUser.last_name,
            ].filter(Boolean).join(" ") ||
            publicUser.username ||
            "Applicant",
        },
        user: res.locals.user || publicUser,
        allowedModules: [],
        currentPath: req.originalUrl || req.path || "",
        form,
        progress,
        formData,
        applicationDetails,
        applicationDocuments,
      },
    );
  } catch (error) {
    next(error);
  }
}


// POST /applicant/applications/:applicationId/documents/:documentType
export async function uploadApplicationDocument(
  req,
  res,
  next,
) {
  let storedAbsolutePath = null;

  try {
    const applicantUserId = Number(
      req.session?.publicUser?.id || 0,
    );

    const applicationId = Number(
      req.params.applicationId || 0,
    );

    const configuration =
      getApplicationDocumentConfiguration(
        req.params.documentType,
      );

    if (
      !applicantUserId ||
      !applicationId ||
      !configuration
    ) {
      return res.status(400).json({
        ok: false,
        message:
          "Invalid application document request.",
      });
    }

    if (!req.file?.buffer) {
      return res.status(400).json({
        ok: false,
        message: "Select a document to upload.",
      });
    }

    const application =
      await loadOwnedApplicantApplication(
        applicationId,
        applicantUserId,
      );

    if (!application) {
      return res.status(404).json({
        ok: false,
        message: "Application record not found.",
      });
    }

    const applicationStatus = String(
      application.application_status || "",
    ).toUpperCase();

    if (
      [
        "SUBMITTED",
        "UNDER_REVIEW",
        "ADMITTED",
        "REJECTED",
        "WITHDRAWN",
      ].includes(applicationStatus)
    ) {
      return res.status(409).json({
        ok: false,
        message:
          "Documents can no longer be changed for this application.",
      });
    }

    const paymentStatus = String(
      application.application_payment_status || "",
    ).toUpperCase();

    if (
      !["PAID", "NOT_REQUIRED"].includes(
        paymentStatus,
      )
    ) {
      return res.status(403).json({
        ok: false,
        message:
          "Complete the application payment before uploading documents.",
      });
    }

    const extension = path
      .extname(req.file.originalname || "")
      .toLowerCase();

    const fileHash = crypto
      .createHash("sha256")
      .update(req.file.buffer)
      .digest("hex");

    const applicationDirectory = path.join(
      APPLICATION_DOCUMENT_ROOT,
      String(applicationId),
    );

    await fs.mkdir(applicationDirectory, {
      recursive: true,
    });

    const randomPart =
      crypto.randomBytes(12).toString("hex");

    const storedFilename =
      `${configuration.databaseType.toLowerCase()}-` +
      `${Date.now()}-${randomPart}${extension}`;

    storedAbsolutePath = path.join(
      applicationDirectory,
      storedFilename,
    );

    await fs.writeFile(
      storedAbsolutePath,
      req.file.buffer,
      {
        flag: "wx",
        mode: 0o600,
      },
    );

    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      await connection.query(
        `
          UPDATE application_documents
          SET
            is_current = 0,
            replaced_at = NOW()
          WHERE applicant_application_id = ?
            AND document_type = ?
            AND is_current = 1
            AND deleted_at IS NULL
        `,
        [
          applicationId,
          configuration.databaseType,
        ],
      );

      const [result] = await connection.query(
        `
          INSERT INTO application_documents (
            applicant_application_id,
            document_type,
            document_label,
            original_filename,
            stored_filename,
            storage_path,
            mime_type,
            file_extension,
            size_bytes,
            file_hash,
            uploaded_by_applicant_user_id,
            is_current
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `,
        [
          applicationId,
          configuration.databaseType,
          configuration.label,
          path.basename(
            req.file.originalname ||
              "application-document",
          ),
          storedFilename,
          storedAbsolutePath,
          req.file.mimetype,
          extension,
          Number(req.file.size || 0),
          fileHash,
          applicantUserId,
        ],
      );

      await connection.commit();

      storedAbsolutePath = null;

      return res.status(201).json({
        ok: true,
        message:
          `${configuration.label} uploaded successfully.`,
        document: {
          id: result.insertId,
          applicationId,
          documentType:
            configuration.databaseType,
          documentLabel:
            configuration.label,
          originalFilename:
            path.basename(
              req.file.originalname ||
                "application-document",
            ),
          mimeType: req.file.mimetype,
          sizeBytes: Number(
            req.file.size || 0,
          ),
          downloadUrl:
            `/applicant/applications/${applicationId}` +
            `/documents/${result.insertId}/download`,
        },
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    if (storedAbsolutePath) {
      await fs.unlink(storedAbsolutePath).catch(
        () => {},
      );
    }

    next(error);
  }
}


// GET /applicant/applications/:applicationId/documents/:documentId/download
export async function downloadApplicationDocument(
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

    const documentId = Number(
      req.params.documentId || 0,
    );

    if (
      !applicantUserId ||
      !applicationId ||
      !documentId
    ) {
      return res.status(400).send(
        "Invalid application document request.",
      );
    }

    const [rows] = await pool.query(
      `
        SELECT
          ad.id,
          ad.original_filename,
          ad.storage_path,
          ad.mime_type
        FROM application_documents ad
        INNER JOIN applicant_applications aa
          ON aa.id =
            ad.applicant_application_id
        WHERE ad.id = ?
          AND ad.applicant_application_id = ?
          AND aa.applicant_user_id = ?
          AND ad.is_current = 1
          AND ad.deleted_at IS NULL
        LIMIT 1
      `,
      [
        documentId,
        applicationId,
        applicantUserId,
      ],
    );

    const document = rows?.[0] || null;

    if (!document) {
      return res.status(404).send(
        "Application document not found.",
      );
    }

    const absolutePath =
      safeApplicationStoragePath(
        document.storage_path,
      );

    if (!absolutePath) {
      return res.status(403).send(
        "Invalid application document path.",
      );
    }

    await fs.access(absolutePath);

    if (document.mime_type) {
      res.type(document.mime_type);
    }

    if (
      String(req.query?.inline || "") === "1"
    ) {
      const inlineFilename = path.basename(
        document.original_filename ||
          "application-document",
      ).replace(/[\r\n"]/g, "");

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${inlineFilename}"`,
      );

      return res.sendFile(absolutePath);
    }

    return res.download(
      absolutePath,
      path.basename(
        document.original_filename ||
          "application-document",
      ),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return res.status(404).send(
        "Application document file is unavailable.",
      );
    }

    next(error);
  }
}


// GET /applicant/application/return
export async function returnToApplication(req, res, next) {
  try {
    const publicUser = await loadApplicantProfile(
      req.session?.publicUser || {},
    );

    if (!publicUser?.id) {
      return res.redirect("/login");
    }

    const [applications] = await pool.query(
      `
        SELECT
          aa.id,
          aa.application_number,
          aa.application_payment_status,
          aa.status AS application_status,
          aa.created_at,
          aa.submitted_at,
          af.title AS application_title,
          af.slug AS application_slug,
          af.category,
          pi.order_id,
          pi.rrr,
          pi.status AS invoice_status,
          pi.amount,
          pi.portal_charge,
          pi.method,
          pi.paid_at
        FROM applicant_applications aa
        JOIN application_forms af
          ON af.id = aa.application_form_id
        LEFT JOIN payment_invoices pi
          ON pi.id = aa.application_invoice_id
        WHERE aa.applicant_user_id = ?
        ORDER BY aa.created_at DESC, aa.id DESC
      `,
      [publicUser.id],
    );

    const fullName = [
      publicUser.first_name,
      publicUser.middle_name,
      publicUser.last_name,
    ]
      .filter(Boolean)
      .join(" ");

    return res.render(
      "applications/applicant-applications",
      {
        layout: "layouts/adminlte",
        title: "Return to Application",
        pageTitle: "My Applications",
        _role: "applicant",
        _user: {
          full_name:
            fullName ||
            publicUser.username ||
            "Applicant",
        },
        user: res.locals.user || publicUser,
        allowedModules: [],
        currentPath:
          req.originalUrl || req.path || "",
        applications: applications || [],
        messages: req.flash ? req.flash() : {},
      },
    );
  } catch (error) {
    next(error);
  }
}

// GET /applicant/payments/history
export async function paymentHistory(req, res, next) {
  try {
    const publicUser = await loadApplicantProfile(
      req.session?.publicUser || {},
    );

    if (!publicUser?.id) {
      return res.redirect("/login");
    }

    const [payments] = await pool.query(
      `
        SELECT
          aa.id AS applicant_application_id,
          aa.application_number,
          aa.application_payment_status,
          aa.status AS application_status,
          af.title AS application_title,
          af.slug AS application_slug,
          pi.id AS invoice_id,
          pi.order_id,
          pi.rrr,
          pi.status AS invoice_status,
          pi.amount,
          pi.portal_charge,
          pi.method,
          pi.created_at,
          pi.paid_at
        FROM applicant_applications aa
        JOIN application_forms af
          ON af.id = aa.application_form_id
        LEFT JOIN payment_invoices pi
          ON pi.id = aa.application_invoice_id
        WHERE aa.applicant_user_id = ?
        ORDER BY
          COALESCE(pi.created_at, aa.created_at) DESC,
          aa.id DESC
      `,
      [publicUser.id],
    );

    const fullName = [
      publicUser.first_name,
      publicUser.middle_name,
      publicUser.last_name,
    ]
      .filter(Boolean)
      .join(" ");

    return res.render(
      "applications/applicant-payment-history",
      {
        layout: "layouts/adminlte",
        title: "Payment History",
        pageTitle: "Application Payment History",
        _role: "applicant",
        _user: {
          full_name:
            fullName ||
            publicUser.username ||
            "Applicant",
        },
        user: res.locals.user || publicUser,
        allowedModules: [],
        currentPath:
          req.originalUrl || req.path || "",
        payments: payments || [],
        messages: req.flash ? req.flash() : {},
      },
    );
  } catch (error) {
    next(error);
  }
}

// GET /applicant/payments/other
export function otherPayment(req, res) {
  return res.redirect("/payment");
}


// GET /applicant/payments/acceptance
export async function acceptanceFee(req, res, next) {
  try {
    const publicUser = await loadApplicantProfile(
      req.session?.publicUser || {},
    );

    if (!publicUser?.id) {
      return res.redirect("/login");
    }

    const applications =
      await listAcceptanceApplications(
        publicUser.id,
      );

    const fullName = [
      publicUser.first_name,
      publicUser.middle_name,
      publicUser.last_name,
    ]
      .filter(Boolean)
      .join(" ");

    return res.render(
      "applications/applicant-acceptance-fee",
      {
        layout: "layouts/adminlte",
        title: "Pay Acceptance Fee",
        pageTitle: "Acceptance Fee",
        _role: "applicant",
        _user: {
          full_name:
            fullName ||
            publicUser.username ||
            "Applicant",
        },
        user: res.locals.user || publicUser,
        allowedModules: [],
        currentPath:
          req.originalUrl || req.path || "",
        applications,
        csrfToken: req.csrfToken?.() || "",
        messages: req.flash ? req.flash() : {},
      },
    );
  } catch (error) {
    next(error);
  }
}

// POST /applicant/payments/acceptance/:applicationId/start
export async function startAcceptanceFee(
  req,
  res,
  next,
) {
  try {
    const publicUser = await loadApplicantProfile(
      req.session?.publicUser || {},
    );

    if (!publicUser?.id) {
      return res.redirect("/login");
    }

    const result =
      await startOrResumeAcceptancePayment({
        applicationId: Number(
          req.params.applicationId,
        ),
        applicant: publicUser,
      });

    if (result.status === "PAID") {
      return res.redirect(
        `/payment/print/${encodeURIComponent(
          result.orderId,
        )}?type=receipt&dl=0`,
      );
    }

    return res.redirect(
      `/payment?from=application&order_id=${encodeURIComponent(
        result.orderId,
      )}`,
    );
  } catch (error) {
    console.error(
      "[acceptanceFee] Unable to start payment:",
      error,
    );

    req.flash?.(
      "error",
      error?.message ||
        "Unable to start acceptance-fee payment.",
    );

    return res.redirect(
      "/applicant/payments/acceptance",
    );
  }
}


async function loadApplicantPortalApplications(
  applicantUserId,
) {
  const [rows] = await pool.query(
    `
      SELECT
        aa.id,
        aa.application_number,
        aa.status AS application_status,
        aa.created_at,
        aa.submitted_at,
        af.title AS application_title,
        af.slug AS application_slug,
        af.category
      FROM applicant_applications aa
      JOIN application_forms af
        ON af.id = aa.application_form_id
      WHERE aa.applicant_user_id = ?
        AND aa.status <> 'WITHDRAWN'
      ORDER BY aa.created_at DESC, aa.id DESC
    `,
    [applicantUserId],
  );

  return rows || [];
}

async function loadOwnedApplicantApplication(
  applicationId,
  applicantUserId,
) {
  const [rows] = await pool.query(
    `
      SELECT
        aa.id,
        aa.application_form_id,
        aa.applicant_user_id,
        aa.application_payment_status,
        aa.application_number,
        aa.status AS application_status,
        aa.created_at,
        aa.submitted_at,
        af.title AS application_title,
        af.slug AS application_slug,
        af.category
      FROM applicant_applications aa
      JOIN application_forms af
        ON af.id = aa.application_form_id
      WHERE aa.id = ?
        AND aa.applicant_user_id = ?
      LIMIT 1
    `,
    [applicationId, applicantUserId],
  );

  return rows?.[0] || null;
}

function applicantPageUser(publicUser) {
  const fullName = [
    publicUser.first_name,
    publicUser.middle_name,
    publicUser.last_name,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    full_name:
      fullName ||
      publicUser.username ||
      "Applicant",
  };
}

// GET /applicant/result/check
export async function checkResult(req, res, next) {
  try {
    const publicUser = await loadApplicantProfile(
      req.session?.publicUser || {},
    );

    if (!publicUser?.id) {
      return res.redirect("/login");
    }

    const applications =
      await loadApplicantPortalApplications(
        publicUser.id,
      );

    return res.render(
      "applications/applicant-result-list",
      {
        layout: "layouts/adminlte",
        title: "Check Result",
        pageTitle: "Application Results",
        _role: "applicant",
        _user: applicantPageUser(publicUser),
        user: res.locals.user || publicUser,
        allowedModules: [],
        currentPath:
          req.originalUrl || req.path || "",
        applications,
      },
    );
  } catch (error) {
    next(error);
  }
}

// GET /applicant/result/check/:applicationId
export async function checkResultDetail(
  req,
  res,
  next,
) {
  try {
    const publicUser = await loadApplicantProfile(
      req.session?.publicUser || {},
    );

    if (!publicUser?.id) {
      return res.redirect("/login");
    }

    const application =
      await loadOwnedApplicantApplication(
        Number(req.params.applicationId),
        publicUser.id,
      );

    if (!application) {
      return res.status(404).send(
        "Application not found.",
      );
    }

    return res.render(
      "applications/applicant-result-status",
      {
        layout: "layouts/adminlte",
        title: "Check Result",
        pageTitle: "Application Result",
        _role: "applicant",
        _user: applicantPageUser(publicUser),
        user: res.locals.user || publicUser,
        allowedModules: [],
        currentPath:
          req.originalUrl || req.path || "",
        application,
      },
    );
  } catch (error) {
    next(error);
  }
}

// GET /applicant/exam-date/view
export async function examDateView(
  req,
  res,
  next,
) {
  try {
    const publicUser = await loadApplicantProfile(
      req.session?.publicUser || {},
    );

    if (!publicUser?.id) {
      return res.redirect("/login");
    }

    const applications =
      await loadApplicantPortalApplications(
        publicUser.id,
      );

    return res.render(
      "applications/applicant-exam-date-list",
      {
        layout: "layouts/adminlte",
        title: "Entrance Examination Date",
        pageTitle: "Entrance Examination Date",
        _role: "applicant",
        _user: applicantPageUser(publicUser),
        user: res.locals.user || publicUser,
        allowedModules: [],
        currentPath:
          req.originalUrl || req.path || "",
        applications,
      },
    );
  } catch (error) {
    next(error);
  }
}

// GET /applicant/exam-date/view/:applicationId
export async function examDateDetail(
  req,
  res,
  next,
) {
  try {
    const publicUser = await loadApplicantProfile(
      req.session?.publicUser || {},
    );

    if (!publicUser?.id) {
      return res.redirect("/login");
    }

    const application =
      await loadOwnedApplicantApplication(
        Number(req.params.applicationId),
        publicUser.id,
      );

    if (!application) {
      return res.status(404).send(
        "Application not found.",
      );
    }

    return res.render(
      "applications/applicant-exam-date",
      {
        layout: "layouts/adminlte",
        title: "Entrance Examination Date",
        pageTitle: "Entrance Examination Date",
        _role: "applicant",
        _user: applicantPageUser(publicUser),
        user: res.locals.user || publicUser,
        allowedModules: [],
        currentPath:
          req.originalUrl || req.path || "",
        application,
      },
    );
  } catch (error) {
    next(error);
  }
}

// GET /applicant/uniform
export async function uniformForm(req, res) {
  const personRole = 'APPLICANT';
  const pu = req.session?.publicUser || {};
  const personId = (pu.username || pu.appNo || '').trim();

  let sessionId = null;
  try {
    const [cur] = await pool.query('SELECT id FROM sessions WHERE is_current=1 LIMIT 1');
    sessionId = cur?.[0]?.id ?? null;
  } catch {}

  // existing record (if any)
  let data = {};
  try {
    const [rows] = await pool.query(
      `SELECT * FROM uniform_measurements WHERE person_role=? AND person_id=? AND session_id <=> ? LIMIT 1`,
      [personRole, personId, sessionId]
    );
    data = rows[0] || {};
  } catch {}

  // dropdown data
  let schools = [], departments = [];
  try {
    const [r1] = await pool.query('SELECT id, name FROM schools ORDER BY name');
    const [r2] = await pool.query('SELECT id, name, school_id FROM departments ORDER BY name');
    schools = r1; departments = r2;
  } catch {}

  res.render('uniform/uniform', {
    title: 'Uniform Measurement',
    pageTitle: 'Uniform Measurement',
    mode: data?.id ? 'edit' : 'create',
    data, personRole, personId, sessionId, schools, departments
  });
}

// POST /applicant/uniform
export async function saveUniform(req, res) {
  const b = req.body || {};
  const personRole = 'APPLICANT';
  const pu = req.session?.publicUser || {};
  const personId = (pu.username || pu.appNo || '').trim();

  let sessionId = null;
  try {
    const [cur] = await pool.query('SELECT id FROM sessions WHERE is_current=1 LIMIT 1');
    sessionId = cur?.[0]?.id ?? null;
  } catch {}

  const sql = `
    INSERT INTO uniform_measurements
      (person_role, person_id, session_id, school_id, department_id, programme, level, entry_year,
       gender, height_cm, weight_kg, cap_size_cm, neck_cm, chest_cm, bust_cm, waist_cm, hips_cm,
       shoulder_cm, sleeve_cm, top_length_cm, trouser_len_cm, skirt_len_cm, shoe_size,
       color_cap, color_top, color_bottom, color_tie, status)
    VALUES (?,?,?,?,?,?,?,?,?,
            ?,?,?,?,?,?,?,?,?,?,
            ?,?,?,?,
            ?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      school_id=VALUES(school_id), department_id=VALUES(department_id), programme=VALUES(programme),
      level=VALUES(level), entry_year=VALUES(entry_year), gender=VALUES(gender),
      height_cm=VALUES(height_cm), weight_kg=VALUES(weight_kg), cap_size_cm=VALUES(cap_size_cm),
      neck_cm=VALUES(neck_cm), chest_cm=VALUES(chest_cm), bust_cm=VALUES(bust_cm), waist_cm=VALUES(waist_cm),
      hips_cm=VALUES(hips_cm), shoulder_cm=VALUES(shoulder_cm), sleeve_cm=VALUES(sleeve_cm),
      top_length_cm=VALUES(top_length_cm), trouser_len_cm=VALUES(trouser_len_cm), skirt_len_cm=VALUES(skirt_len_cm),
      shoe_size=VALUES(shoe_size), color_cap=VALUES(color_cap), color_top=VALUES(color_top),
      color_bottom=VALUES(color_bottom), color_tie=VALUES(color_tie), status=VALUES(status)
  `;

  const params = [
    personRole, personId, sessionId,
    b.school_id || null, b.department_id || null, b.programme || null, b.level || null, b.entry_year || null,
    b.gender || null, b.height_cm || null, b.weight_kg || null, b.cap_size_cm || null, b.neck_cm || null,
    b.chest_cm || null, b.bust_cm || null, b.waist_cm || null, b.hips_cm || null,
    b.shoulder_cm || null, b.sleeve_cm || null, b.top_length_cm || null, b.trouser_len_cm || null, b.skirt_len_cm || null,
    b.shoe_size || null,
    b.color_cap || null, b.color_top || null, b.color_bottom || null, b.color_tie || null,
    (b.complete === '1') ? 'COMPLETED' : 'DRAFT'
  ];

  try { await pool.query(sql, params); } catch {}

  req.flash('success', (b.complete === '1') ? 'Uniform measurement submitted.' : 'Uniform measurement saved (draft).');
  return res.redirect('/applicant/uniform');
}

// GET /applicant/uniform/print
export async function uniformPrint(req, res) {
  const personRole = 'APPLICANT';
  const pu = req.session?.publicUser || {};
  const personId = (pu.username || pu.appNo || '').trim();

  let sessionId = null;
  try {
    const [cur] = await pool.query('SELECT id FROM sessions WHERE is_current=1 LIMIT 1');
    sessionId = cur?.[0]?.id ?? null;
  } catch {}

  const [rows] = await pool.query(
    `SELECT um.*, s.name AS school_name, d.name AS department_name
     FROM uniform_measurements um
     LEFT JOIN schools s ON s.id = um.school_id
     LEFT JOIN departments d ON d.id = um.department_id
     WHERE um.person_role=? AND um.person_id=? AND um.session_id <=> ? LIMIT 1`,
    [personRole, personId, sessionId]
  );
  const rec = rows[0] || {};

  // Build name: session → DB fallback
  let personName = (pu.first_name || pu.last_name)
    ? [pu.first_name, pu.middle_name, pu.last_name].filter(Boolean).join(' ')
    : '';

  if (!personName && personId) {
    try {
      const [pr] = await pool.query(
        'SELECT first_name, middle_name, last_name FROM public_users WHERE username=? LIMIT 1',
        [personId]
      );
      if (pr[0]) personName = [pr[0].first_name, pr[0].middle_name, pr[0].last_name].filter(Boolean).join(' ');
    } catch {}
  }

  res.render('uniform/print', {
    title: 'Uniform Measurement',
    pageTitle: 'Uniform Measurement',
    record: rec,
    personRole,
    personId,
    personName,
    sessionId
  });
}

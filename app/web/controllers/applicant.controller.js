// app/web/controllers/applicant.controller.js
import { pool } from '../../core/db.js';
import {
  getOpenApplicationFormBySlug,
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

    const submitted =
      String(req.body?.action || "").toLowerCase() ===
      "submit";

    const updatedData = {
      ...existingData,
      sample_application: {
        programme_choice: String(
          req.body?.programme_choice || "",
        ).trim(),
        qualification_summary: String(
          req.body?.qualification_summary || "",
        ).trim(),
        additional_note: String(
          req.body?.additional_note || "",
        ).trim(),
      },
    };

    if (
      submitted &&
      !updatedData.sample_application.programme_choice
    ) {
      req.flash?.(
        "error",
        "Programme choice is required before submission.",
      );

      return res.redirect(
        `/applicant/applications/${encodeURIComponent(
          form.slug,
        )}/form`,
      );
    }

    await pool.query(
      `
        UPDATE applicant_applications
        SET
          programme_choice = ?,
          qualification_summary = ?,
          additional_note = ?,
          form_data = ?,
          status = ?,
          submitted_at = CASE
            WHEN ? = 'SUBMITTED' THEN NOW()
            ELSE submitted_at
          END
        WHERE id = ?
      `,
      [
        updatedData.sample_application.programme_choice ||
          null,
        updatedData.sample_application
          .qualification_summary || null,
        updatedData.sample_application.additional_note ||
          null,
        JSON.stringify(updatedData),
        submitted ? "SUBMITTED" : "IN_PROGRESS",
        submitted ? "SUBMITTED" : "IN_PROGRESS",
        progress.id,
      ],
    );

    req.flash?.(
      "success",
      submitted
        ? "Application submitted successfully."
        : "Application saved as draft.",
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

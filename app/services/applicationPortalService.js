import db from "../core/db.js";

function clean(value) {
  return String(value ?? "").trim();
}

function normalizePhone(value) {
  return clean(value).replace(/\D+/g, "");
}

function normalizeName(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function verifiedCandidateRecord(row) {
  if (!row) return null;

  return {
    id: row.id,
    candidate_reference: row.candidate_reference,
    first_name: row.first_name,
    middle_name: row.middle_name,
    surname: row.surname,
    jamb_total_score: row.jamb_total_score,
    state_of_origin: row.state_of_origin,
    lga: row.lga,
    gender: row.gender,
  };
}

export async function loadApplicantProfile(sessionUser = {}) {
  const id = Number(sessionUser.id || 0);
  const username = clean(sessionUser.username);

  if (id) {
    const [rows] = await db.query(
      `
        SELECT
          id,
          role,
          first_name,
          middle_name,
          last_name,
          username,
          phone,
          state_of_origin,
          lga
        FROM public_users
        WHERE id = ?
          AND role = 'applicant'
        LIMIT 1
      `,
      [id],
    );

    if (rows?.[0]) return rows[0];
  }

  if (username) {
    const [rows] = await db.query(
      `
        SELECT
          id,
          role,
          first_name,
          middle_name,
          last_name,
          username,
          phone,
          state_of_origin,
          lga
        FROM public_users
        WHERE username = ?
          AND role = 'applicant'
        LIMIT 1
      `,
      [username],
    );

    if (rows?.[0]) return rows[0];
  }

  return sessionUser || {};
}

export async function listOpenApplicationForms() {
  const [rows] = await db.query(`
    SELECT
      f.id,
      f.code,
      f.slug,
      f.title,
      f.category,
      f.description,
      f.opens_at,
      f.closes_at,
      f.requires_prerequisite,
      f.prerequisite_match_mode,
      s.name AS session_name,
      COALESCE(
        SUM(
          CASE
            WHEN c.charge_stage = 'APPLICATION'
              AND c.is_active = 1
            THEN c.amount
            ELSE 0
          END
        ),
        0
      ) AS application_total
    FROM application_forms f
    LEFT JOIN sessions s
      ON s.id = f.session_id
    LEFT JOIN application_form_charges c
      ON c.application_form_id = f.id
    WHERE f.status = 'OPEN'
      AND f.opens_at <= NOW()
      AND f.closes_at >= NOW()
    GROUP BY
      f.id,
      f.code,
      f.slug,
      f.title,
      f.category,
      f.description,
      f.opens_at,
      f.closes_at,
      f.requires_prerequisite,
      f.prerequisite_match_mode,
      s.name
    ORDER BY f.opens_at DESC, f.title ASC
  `);

  return rows || [];
}

export async function getOpenApplicationFormBySlug(slug) {
  const [rows] = await db.query(
    `
      SELECT
        f.*,
        s.name AS session_name
      FROM application_forms f
      LEFT JOIN sessions s
        ON s.id = f.session_id
      WHERE f.slug = ?
        AND f.status = 'OPEN'
        AND f.opens_at <= NOW()
        AND f.closes_at >= NOW()
      LIMIT 1
    `,
    [clean(slug)],
  );

  const form = rows?.[0] || null;
  if (!form) return null;

  const [charges] = await db.query(
    `
      SELECT
        id,
        charge_name,
        charge_stage,
        amount,
        display_order
      FROM application_form_charges
      WHERE application_form_id = ?
        AND is_active = 1
      ORDER BY charge_stage ASC, display_order ASC, id ASC
    `,
    [form.id],
  );

  form.application_charges = (charges || []).filter(
    (row) => row.charge_stage === "APPLICATION",
  );

  form.acceptance_charges = (charges || []).filter(
    (row) => row.charge_stage === "ACCEPTANCE",
  );

  form.application_total = form.application_charges.reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0,
  );

  form.acceptance_total = form.acceptance_charges.reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0,
  );

  return form;
}

export async function getApplicationFormBySlug(slug) {
  const openForm =
    await getOpenApplicationFormBySlug(slug);

  if (openForm) {
    return openForm;
  }

  const [rows] = await db.query(
    `
      SELECT
        f.*,
        s.name AS session_name
      FROM application_forms f
      LEFT JOIN sessions s
        ON s.id = f.session_id
      WHERE f.slug = ?
      LIMIT 1
    `,
    [clean(slug)],
  );

  const form = rows?.[0] || null;

  if (!form) {
    return null;
  }

  const [charges] = await db.query(
    `
      SELECT
        id,
        charge_name,
        charge_stage,
        amount,
        display_order
      FROM application_form_charges
      WHERE application_form_id = ?
        AND is_active = 1
      ORDER BY
        charge_stage ASC,
        display_order ASC,
        id ASC
    `,
    [form.id],
  );

  form.application_charges = (charges || []).filter(
    (row) => row.charge_stage === "APPLICATION",
  );

  form.acceptance_charges = (charges || []).filter(
    (row) => row.charge_stage === "ACCEPTANCE",
  );

  form.application_total =
    form.application_charges.reduce(
      (sum, row) =>
        sum + Number(row.amount || 0),
      0,
    );

  form.acceptance_total =
    form.acceptance_charges.reduce(
      (sum, row) =>
        sum + Number(row.amount || 0),
      0,
    );

  return form;
}

export async function checkApplicantPrerequisite(
  form,
  publicUser = {},
) {
  if (Number(form?.requires_prerequisite) !== 1) {
    return {
      eligible: true,
      restricted: false,
      reason: "No prerequisite list is required for this application.",
      verified_record: null,
    };
  }

  const mode = clean(
    form.prerequisite_match_mode,
  ).toUpperCase();

  if (mode === "REFERENCE") {
    const applicantId = Number(publicUser.id || 0);

    if (!applicantId) {
      return {
        eligible: false,
        restricted: true,
        requires_reference_verification: true,
        reason:
          "Enter your JAMB registration number to verify your eligibility.",
        verified_record: null,
      };
    }

    const [rows] = await db.query(
      `
        SELECT
          id,
          candidate_reference,
          first_name,
          middle_name,
          surname,
          jamb_total_score,
          state_of_origin,
          lga,
          gender,
          match_status
        FROM application_prerequisites
        WHERE application_form_id = ?
          AND matched_applicant_user_id = ?
          AND match_status IN ('MATCHED', 'USED')
        ORDER BY id DESC
        LIMIT 1
      `,
      [form.id, applicantId],
    );

    if (rows?.[0]) {
      return {
        eligible: true,
        restricted: true,
        verified: true,
        reason:
          "Your JAMB record has been verified successfully.",
        verified_record: verifiedCandidateRecord(rows[0]),
      };
    }

    return {
      eligible: false,
      restricted: true,
      requires_reference_verification: true,
      reason:
        "Enter your JAMB registration number to verify your eligibility.",
      verified_record: null,
    };
  }

  let sql = "";
  let values = [];

  if (mode === "EMAIL") {
    const email = clean(
      publicUser.email || publicUser.username,
    );

    if (!email) {
      return {
        eligible: false,
        restricted: true,
        reason:
          "Your applicant profile does not contain the required information.",
        verified_record: null,
      };
    }

    sql = `
      SELECT
        id,
        candidate_reference,
        first_name,
        middle_name,
        surname,
        jamb_total_score,
        state_of_origin,
        lga,
        gender
      FROM application_prerequisites
      WHERE application_form_id = ?
        AND match_status <> 'INVALID'
        AND LOWER(TRIM(email)) = LOWER(TRIM(?))
      LIMIT 1
    `;

    values = [form.id, email];
  } else if (mode === "PHONE") {
    const phone = normalizePhone(publicUser.phone);

    if (!phone) {
      return {
        eligible: false,
        restricted: true,
        reason:
          "Your applicant profile does not contain the required information.",
        verified_record: null,
      };
    }

    const [rows] = await db.query(
      `
        SELECT
          id,
          candidate_reference,
          first_name,
          middle_name,
          surname,
          jamb_total_score,
          state_of_origin,
          lga,
          gender,
          phone
        FROM application_prerequisites
        WHERE application_form_id = ?
          AND match_status <> 'INVALID'
          AND phone IS NOT NULL
      `,
      [form.id],
    );

    const matched = (rows || []).find(
      (row) => normalizePhone(row.phone) === phone,
    );

    return {
      eligible: Boolean(matched),
      restricted: true,
      reason: matched
        ? "Your prerequisite record has been verified successfully."
        : "Your prerequisite record could not be verified.",
      verified_record: verifiedCandidateRecord(matched),
    };
  } else if (mode === "NAME") {
    const firstName = clean(publicUser.first_name);
    const surname = clean(
      publicUser.last_name || publicUser.surname,
    );

    if (!firstName || !surname) {
      return {
        eligible: false,
        restricted: true,
        reason:
          "Your applicant profile does not contain the required information.",
        verified_record: null,
      };
    }

    sql = `
      SELECT
        id,
        candidate_reference,
        first_name,
        middle_name,
        surname,
        jamb_total_score,
        state_of_origin,
        lga,
        gender
      FROM application_prerequisites
      WHERE application_form_id = ?
        AND match_status <> 'INVALID'
        AND LOWER(TRIM(first_name)) = LOWER(TRIM(?))
        AND LOWER(TRIM(surname)) = LOWER(TRIM(?))
      LIMIT 1
    `;

    values = [form.id, firstName, surname];
  } else {
    return {
      eligible: false,
      restricted: true,
      reason:
        "This application prerequisite is not configured correctly.",
      verified_record: null,
    };
  }

  const [rows] = await db.query(sql, values);
  const matched = rows?.[0] || null;

  return {
    eligible: Boolean(matched),
    restricted: true,
    reason: matched
      ? "Your prerequisite record has been verified successfully."
      : "Your prerequisite record could not be verified.",
    verified_record: verifiedCandidateRecord(matched),
  };
}

export async function verifyApplicantReference(
  form,
  publicUser = {},
  submittedReference,
) {
  const genericMismatchMessage =
    "This record does not match your portal profile information. " +
    "Please double-check the JAMB registration number and ensure that " +
    "your portal profile matches the information used during JAMB " +
    "registration. To correct your portal profile, visit the ICT " +
    "Department, or create a new applicant profile using the same " +
    "information used for your JAMB registration.";

  if (
    Number(form?.requires_prerequisite) !== 1 ||
    clean(form?.prerequisite_match_mode).toUpperCase() !==
      "REFERENCE"
  ) {
    return {
      ok: false,
      message:
        "JAMB registration-number verification is not required for this application.",
    };
  }

  const applicantId = Number(publicUser.id || 0);
  const applicantSurname = clean(
    publicUser.last_name || publicUser.surname,
  );
  const jambRegistrationNumber = clean(submittedReference);

  if (!jambRegistrationNumber) {
    return {
      ok: false,
      message: "Enter your JAMB registration number.",
    };
  }

  if (!applicantId || !applicantSurname) {
    return {
      ok: false,
      message: genericMismatchMessage,
    };
  }

  const [rows] = await db.query(
    `
      SELECT
        id,
        candidate_reference,
        first_name,
        middle_name,
        surname,
        email,
        phone,
        jamb_total_score,
        state_of_origin,
        lga,
        gender,
        matched_applicant_user_id,
        match_status
      FROM application_prerequisites
      WHERE application_form_id = ?
        AND match_status <> 'INVALID'
        AND LOWER(TRIM(candidate_reference)) =
            LOWER(TRIM(?))
      ORDER BY id DESC
    `,
    [form.id, jambRegistrationNumber],
  );

  if (!rows?.length) {
    return {
      ok: false,
      message: genericMismatchMessage,
    };
  }

  const linkedToAnotherApplicant = rows.some(
    (row) =>
      Number(row.matched_applicant_user_id || 0) > 0 &&
      Number(row.matched_applicant_user_id) !== applicantId,
  );

  if (linkedToAnotherApplicant) {
    return {
      ok: false,
      message:
        "This JAMB record has already been linked to another applicant account. Please visit the ICT Department for assistance.",
    };
  }

  const matchedRow = rows.find(
    (row) =>
      normalizeName(row.surname) ===
      normalizeName(applicantSurname),
  );

  if (!matchedRow) {
    return {
      ok: false,
      message: genericMismatchMessage,
    };
  }

  await db.query(
    `
      UPDATE application_prerequisites
      SET
        matched_applicant_user_id = ?,
        match_status = CASE
          WHEN match_status = 'USED' THEN 'USED'
          ELSE 'MATCHED'
        END
      WHERE id = ?
    `,
    [applicantId, matchedRow.id],
  );

  return {
    ok: true,
    message: "Your JAMB record has been verified successfully.",
    record: verifiedCandidateRecord(matchedRow),
  };
}

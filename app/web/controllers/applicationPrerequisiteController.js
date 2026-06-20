import * as XLSX from "xlsx";
import db from "../../core/db.js";

function clean(value) {
  return String(value ?? "").trim();
}

function getStaffUser(req, res) {
  return (
    req.user ||
    req.session?.user ||
    req.session?.staff ||
    res.locals?.user ||
    null
  );
}

function isAdmin(req, res) {
  const user = getStaffUser(req, res);
  const role = clean(
    user?.role || user?.role_name || user?.type,
  ).toLowerCase();

  return (
    role === "admin" ||
    role === "administrator" ||
    role === "portal administrator"
  );
}

function headerKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizedMap(row) {
  const result = {};

  for (const [key, value] of Object.entries(row || {})) {
    result[headerKey(key)] = value;
  }

  return result;
}

function firstValue(row, aliases) {
  for (const alias of aliases) {
    const value = row[alias];

    if (
      value !== undefined &&
      value !== null &&
      clean(value) !== ""
    ) {
      return clean(value);
    }
  }

  return null;
}

function numberOrNull(value) {
  if (value === undefined || value === null || clean(value) === "") {
    return null;
  }

  const normalized = clean(value).replace(/,/g, "");
  const number = Number(normalized);

  return Number.isFinite(number) ? number : null;
}

function normalizePrerequisiteRow(sourceRow, rowNumber) {
  const row = normalizedMap(sourceRow);

  return {
    row_number: rowNumber,
    s_n: firstValue(row, [
      "s_n",
      "sn",
      "s_no",
      "serial_no",
      "serial_number",
      "number",
    ]),
    candidate_reference: firstValue(row, [
      "candidate_reference",
      "candidate_no",
      "candidate_number",
      "jamb_reg_no",
      "jamb_registration_no",
      "jamb_registration_number",
      "registration_no",
      "registration_number",
      "reference",
    ]),
    first_name: firstValue(row, [
      "first_name",
      "firstname",
      "given_name",
    ]),
    middle_name: firstValue(row, [
      "middle_name",
      "middlename",
      "other_name",
      "other_names",
    ]),
    surname: firstValue(row, [
      "surname",
      "last_name",
      "lastname",
      "family_name",
    ]),
    email: firstValue(row, [
      "email",
      "email_address",
    ]),
    phone: firstValue(row, [
      "phone",
      "phone_number",
      "mobile",
      "mobile_number",
      "telephone",
    ]),
    jamb_total_score: numberOrNull(
      firstValue(row, [
        "jamb_total_score",
        "jamb_score",
        "total_score",
        "score",
      ]),
    ),
    state_of_origin: firstValue(row, [
      "state_of_origin",
      "state",
    ]),
    lga: firstValue(row, [
      "lga",
      "local_government",
      "local_government_area",
    ]),
    gender: firstValue(row, [
      "gender",
      "sex",
    ]),
    raw_data: JSON.stringify(sourceRow || {}),
  };
}

function rowIsValid(row, matchMode) {
  if (matchMode === "REFERENCE") {
    return Boolean(row.candidate_reference);
  }

  if (matchMode === "EMAIL") {
    return Boolean(row.email);
  }

  if (matchMode === "PHONE") {
    return Boolean(row.phone);
  }

  if (matchMode === "NAME") {
    return Boolean(row.first_name && row.surname);
  }

  return false;
}

export async function downloadPrerequisiteTemplate(req, res) {
  const csv = [
    [
      "s_n",
      "candidate_reference",
      "first_name",
      "middle_name",
      "surname",
      "email",
      "phone",
      "jamb_total_score",
      "state_of_origin",
      "lga",
      "gender",
    ].join(","),
    [
      "1",
      "202612345678AB",
      "ADEBAYO",
      "OLUWASEUN",
      "JOHNSON",
      "candidate@example.com",
      "08012345678",
      "245",
      "Ekiti",
      "Ijero",
      "Male",
    ].join(","),
  ].join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="application-prerequisite-template.csv"',
  );

  return res.send(csv);
}

export async function uploadPrerequisites(req, res, next) {
  let connection;

  try {
    if (!isAdmin(req, res)) {
      return res.status(403).json({
        ok: false,
        error: "Only admin users can upload prerequisite lists.",
      });
    }

    const applicationFormId = Number(req.params.id || 0);

    const [formRows] = await db.query(
      `
        SELECT
          id,
          title,
          requires_prerequisite,
          prerequisite_match_mode
        FROM application_forms
        WHERE id = ?
        LIMIT 1
      `,
      [applicationFormId],
    );

    const applicationForm = formRows?.[0] || null;

    if (!applicationForm) {
      return res.status(404).json({
        ok: false,
        error: "Application form not found.",
      });
    }

    if (Number(applicationForm.requires_prerequisite) !== 1) {
      return res.status(400).json({
        ok: false,
        error:
          "Enable the prerequisite requirement and save the application before uploading.",
      });
    }

    if (!req.file?.buffer) {
      return res.status(400).json({
        ok: false,
        error: "Select a CSV or Excel file to upload.",
      });
    }

    const workbook = XLSX.read(req.file.buffer, {
      type: "buffer",
    });

    const firstSheetName = workbook.SheetNames?.[0];

    if (!firstSheetName) {
      return res.status(400).json({
        ok: false,
        error: "The uploaded file does not contain a readable worksheet.",
      });
    }

    const worksheet = workbook.Sheets[firstSheetName];

    const sourceRows = XLSX.utils
      .sheet_to_json(worksheet, {
        defval: "",
        raw: false,
      })
      .filter((row) =>
        Object.values(row || {}).some((value) => clean(value) !== ""),
      );

    if (!sourceRows.length) {
      return res.status(400).json({
        ok: false,
        error: "The uploaded file contains no candidate records.",
      });
    }

    const matchMode = clean(
      applicationForm.prerequisite_match_mode,
    ).toUpperCase();

    const normalizedRows = sourceRows.map((row, index) => {
      const normalized = normalizePrerequisiteRow(row, index + 2);

      return {
        ...normalized,
        is_valid: rowIsValid(normalized, matchMode),
      };
    });

    const validRows = normalizedRows.filter((row) => row.is_valid);
    const invalidRows = normalizedRows.filter((row) => !row.is_valid);

    if (!validRows.length) {
      return res.status(400).json({
        ok: false,
        error:
          `No valid rows were found for the selected ${matchMode} matching method.`,
      });
    }

    const staff = getStaffUser(req, res);

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [batchResult] = await connection.query(
      `
        INSERT INTO application_prerequisite_batches
          (
            application_form_id,
            original_filename,
            imported_rows,
            valid_rows,
            invalid_rows,
            status,
            uploaded_by
          )
        VALUES (?, ?, ?, ?, ?, 'UPLOADED', ?)
      `,
      [
        applicationFormId,
        clean(req.file.originalname) || "prerequisite-upload",
        normalizedRows.length,
        validRows.length,
        invalidRows.length,
        staff?.id || null,
      ],
    );

    for (const row of normalizedRows) {
      await connection.query(
        `
          INSERT INTO application_prerequisites
            (
              application_form_id,
              batch_id,
              row_number,
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
              raw_data,
              match_status
            )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          applicationFormId,
          batchResult.insertId,
          row.row_number,
          row.candidate_reference,
          row.first_name,
          row.middle_name,
          row.surname,
          row.email,
          row.phone,
          row.jamb_total_score,
          row.state_of_origin,
          row.lga,
          row.gender,
          row.raw_data,
          row.is_valid ? "UNMATCHED" : "INVALID",
        ],
      );
    }

    await connection.query(
      `
        UPDATE application_prerequisite_batches
        SET status = 'PROCESSED'
        WHERE id = ?
      `,
      [batchResult.insertId],
    );

    await connection.commit();

    return res.json({
      ok: true,
      message: "Prerequisite list uploaded successfully.",
      batch_id: batchResult.insertId,
      imported_rows: normalizedRows.length,
      valid_rows: validRows.length,
      invalid_rows: invalidRows.length,
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
    }

    next(err);
  } finally {
    connection?.release();
  }
}

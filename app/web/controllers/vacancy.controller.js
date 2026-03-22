// app/web/controllers/vacancy.controller.js
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { pool } from "../../core/db.js";

export const INSTITUTION_NAME =
  "EKITI STATE COLLEGE OF TECHNOLOGY, IJERO EKITI (EKSCOTECH)";

function principalReq(discipline) {
  return `Candidate must possess a Doctorate (Ph.D.) in ${discipline} with twelve (12) years of teaching/research experience or an academic Master Degree with minimum of fifteen (15) years of teaching/research experience. Publications in at least four (4) reputable, peer-reviewed journals as well as membership of relevant professional bodies with demonstrable administrative and leadership qualities are advantages.`;
}

function seniorReq(discipline) {
  return `Candidate must possess an academic Master degree in ${discipline}, with evidence of scholarly publications in reputable, peer-reviewed journals (both local and international). Candidate must have served as Lecturer I for a minimum of three (3) years. Evidence of scholarly publications, active participation and paper presentation at academic conferences, seminars or workshops as well as mandatory registration with professional regulatory body are added advantages.`;
}

function lecturerReq(discipline) {
  return `Candidate must possess an academic Master degree in ${discipline} from a recognized institution. Candidate is expected to have a good first degree in the relevant discipline, with at least a second class lower division. A minimum of nine (9) years of cognate teaching and research experience in a Polytechnic or similar Technical and Vocational Education and Training (TVET) Institution is an added advantage, just as registration with the relevant professional body is necessary.`;
}

function assistantReq(discipline) {
  return `Candidate must possess a good first degree (minimum of second class lower division) from a recognized university in ${discipline}. Candidate must be registered with relevant professional bodies and possess a valid NYSC discharge certificate or exemption certificate.`;
}

function technologistReq(discipline) {
  return `Candidate must possess a Higher National Diploma (HND) or Bachelor’s Degree (minimum lower credit) in ${discipline}, and from a recognized institution. Possession of at least five (5) relevant credit passes (including English and Mathematics) as well as a valid discharge or exemption certificate from the National Youth Service Corps are compulsory requirements, just as registration with relevant professional bodies is an added advantage.`;
}

export const VACANCY_REQUIREMENTS = [
  {
    group: "School of Business and Management",
    title: "Principal Lecturer - Mass Communication",
    requirement: principalReq("Mass Communication"),
  },
  {
    group: "School of Business and Management",
    title: "Senior Lecturer - Mass Communication",
    requirement: seniorReq("Mass Communication"),
  },
  {
    group: "School of Business and Management",
    title: "Lecturer I - Mass Communication",
    requirement: lecturerReq("Mass Communication"),
  },

  {
    group: "School of Business and Management",
    title: "Principal Lecturer - Library and Information Science",
    requirement: principalReq("Library and Information Science"),
  },
  {
    group: "School of Business and Management",
    title: "Senior Lecturer - Library and Information Science",
    requirement: seniorReq("Library and Information Science"),
  },
  {
    group: "School of Business and Management",
    title: "Lecturer I - Library and Information Science",
    requirement: lecturerReq("Library and Information Science"),
  },

  {
    group: "School of Business and Management",
    title: "Principal Lecturer - Accountancy",
    requirement: principalReq("Accountancy"),
  },
  {
    group: "School of Business and Management",
    title: "Senior Lecturer - Accountancy",
    requirement: seniorReq("Accountancy"),
  },
  {
    group: "School of Business and Management",
    title: "Lecturer I - Accountancy",
    requirement: lecturerReq("Accountancy"),
  },

  {
    group: "School of Business and Management",
    title: "Principal Lecturer - Business Administration",
    requirement: principalReq("Business Administration"),
  },
  {
    group: "School of Business and Management",
    title: "Senior Lecturer - Business Administration",
    requirement: seniorReq("Business Administration"),
  },
  {
    group: "School of Business and Management",
    title: "Lecturer I - Business Administration",
    requirement: lecturerReq("Business Administration"),
  },

  {
    group: "School of Engineering",
    title: "Principal Lecturer - Electrical and Electronics Engineering",
    requirement: principalReq("Electrical and Electronics Engineering"),
  },
  {
    group: "School of Engineering",
    title: "Senior Lecturer - Electrical and Electronics Engineering",
    requirement: seniorReq("Electrical and Electronics Engineering"),
  },
  {
    group: "School of Engineering",
    title: "Lecturer I - Electrical and Electronics Engineering",
    requirement: lecturerReq("Electrical and Electronics Engineering"),
  },

  {
    group: "School of Engineering",
    title: "Principal Lecturer - Computer Engineering",
    requirement: principalReq("Computer Engineering"),
  },
  {
    group: "School of Engineering",
    title: "Senior Lecturer - Computer Engineering",
    requirement: seniorReq("Computer Engineering"),
  },
  {
    group: "School of Engineering",
    title: "Lecturer I - Computer Engineering",
    requirement: lecturerReq("Computer Engineering"),
  },

  {
    group: "School of Applied Sciences",
    title: "Principal Lecturer - Science Laboratory Technology",
    requirement: principalReq("Science Laboratory Technology"),
  },
  {
    group: "School of Applied Sciences",
    title: "Senior Lecturer - Science Laboratory Technology",
    requirement: seniorReq("Science Laboratory Technology"),
  },
  {
    group: "School of Applied Sciences",
    title: "Lecturer I - Science Laboratory Technology",
    requirement: lecturerReq("Science Laboratory Technology"),
  },

  {
    group: "School of Applied Sciences",
    title: "Lecturer I - Computer Science",
    requirement: lecturerReq("Computer Science"),
  },

  {
    group: "College Health Centre",
    title: "Medical Officer",
    requirement:
      "Candidate must possess M.B.B.S and be registered with the Medical and Dental Council of Nigeria. The candidate must have observed the mandatory NYSC service evidenced by the discharge certificate.",
  },
];

export const VACANCY_GROUPS = Object.values(
  VACANCY_REQUIREMENTS.reduce((acc, item) => {
    if (!acc[item.group]) {
      acc[item.group] = {
        label: item.group,
        options: [],
      };
    }
    acc[item.group].options.push(item.title);
    return acc;
  }, {}),
);

const NIGERIA_STATES = [
  "Abia",
  "Adamawa",
  "Akwa Ibom",
  "Anambra",
  "Bauchi",
  "Bayelsa",
  "Benue",
  "Borno",
  "Cross River",
  "Delta",
  "Ebonyi",
  "Edo",
  "Ekiti",
  "Enugu",
  "FCT",
  "Gombe",
  "Imo",
  "Jigawa",
  "Kaduna",
  "Kano",
  "Katsina",
  "Kebbi",
  "Kogi",
  "Kwara",
  "Lagos",
  "Nasarawa",
  "Niger",
  "Ogun",
  "Ondo",
  "Osun",
  "Oyo",
  "Plateau",
  "Rivers",
  "Sokoto",
  "Taraba",
  "Yobe",
  "Zamfara",
];

function clean(value) {
  return String(value ?? "").trim();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isPhone(value) {
  return /^[0-9+()\-\s]{10,20}$/.test(value);
}

function calculateAge(dateString) {
  const dob = new Date(dateString);
  if (Number.isNaN(dob.getTime())) return 0;

  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age -= 1;
  }

  return age;
}

function normalizeStoredPath(file) {
  if (!file?.path) return null;
  return path.relative(process.cwd(), file.path).replace(/\\/g, "/");
}

function getSingleFile(files, fieldName) {
  const list = files?.[fieldName];
  return Array.isArray(list) && list.length ? list[0] : null;
}

function getManyFiles(files, fieldName) {
  return Array.isArray(files?.[fieldName]) ? files[fieldName] : [];
}

async function cleanupUploadedFiles(files = {}) {
  const allFiles = Object.values(files).flat().filter(Boolean);
  await Promise.all(
    allFiles.map(async (file) => {
      try {
        if (file?.path) await fs.unlink(file.path);
      } catch {
        // ignore cleanup failure
      }
    }),
  );
}

export function showVacancyForm(req, res) {
  const csrfToken = typeof req.csrfToken === "function" ? req.csrfToken() : "";

  return res.render("pages/vacancy-application", {
    layout: false,
    title: "Staff Vacancy Application | EKSCOTECH",
    csrfToken,
    institutionName: INSTITUTION_NAME,
    vacancyGroups: VACANCY_GROUPS,
    vacancyRequirements: VACANCY_REQUIREMENTS,
    nigeriaStates: NIGERIA_STATES,
    advertEmail: "",
  });
}

export async function submitVacancyApplication(req, res) {
  try {
    const firstName = clean(req.body.first_name);
    const middleName = clean(req.body.middle_name) || null;
    const lastName = clean(req.body.last_name);
    const email = clean(req.body.email).toLowerCase();
    const phone = clean(req.body.phone);
    const alternativePhone = clean(req.body.alternative_phone) || null;
    const dateOfBirth = clean(req.body.date_of_birth);
    const gender = clean(req.body.gender) || null;
    const stateOfOrigin = clean(req.body.state_of_origin);
    const localGovernment = clean(req.body.local_government);
    const houseAddress = clean(req.body.house_address);
    const postApplyingFor = clean(req.body.post_applying_for);
    const declaration = clean(req.body.declaration);

    const cv = getSingleFile(req.files, "cv");
    const otherDocument = getSingleFile(req.files, "other_document");
    const certificates = getManyFiles(req.files, "certificates");

    const errors = {};
    const allowedPosts = new Set(
      VACANCY_REQUIREMENTS.map((item) => item.title),
    );

    if (!firstName) errors.first_name = "First name is required.";
    if (!lastName) errors.last_name = "Last name is required.";

    if (!email) {
      errors.email = "Email address is required.";
    } else if (!isEmail(email)) {
      errors.email = "Please enter a valid email address.";
    }

    if (!phone) {
      errors.phone = "Phone number is required.";
    } else if (!isPhone(phone)) {
      errors.phone = "Please enter a valid phone number.";
    }

    if (alternativePhone && !isPhone(alternativePhone)) {
      errors.alternative_phone =
        "Please enter a valid alternative phone number.";
    }

    if (!dateOfBirth) {
      errors.date_of_birth = "Date of birth is required.";
    } else if (calculateAge(dateOfBirth) < 18) {
      errors.date_of_birth = "Applicant must be at least 18 years old.";
    }

    if (!stateOfOrigin) {
      errors.state_of_origin = "State of origin is required.";
    }

    if (!localGovernment) {
      errors.local_government = "Local government is required.";
    }

    if (!houseAddress) {
      errors.house_address = "House address is required.";
    }

    if (!postApplyingFor) {
      errors.post_applying_for = "Please select the post you are applying for.";
    } else if (!allowedPosts.has(postApplyingFor)) {
      errors.post_applying_for = "Selected post is invalid.";
    }

    if (!cv) {
      errors.cv = "CV upload is required.";
    }

    if (!certificates.length) {
      errors.certificates =
        "Please upload at least one educational certificate.";
    }

    if (declaration !== "1") {
      errors.declaration =
        "You must confirm that the information provided is correct.";
    }

    if (Object.keys(errors).length) {
      await cleanupUploadedFiles(req.files);
      return res.status(422).json({
        ok: false,
        message: "Please correct the highlighted fields and try again.",
        errors,
      });
    }

    const submittedAt = new Date();
    const referenceNo = `EKSCOTECH-JOB-${submittedAt
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "")}-${crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase()}`;

    const fullName = [firstName, middleName, lastName]
      .filter(Boolean)
      .join(" ");

    const certificatesPayload = certificates.map((file) => ({
      original_name: file.originalname,
      stored_name: file.filename,
      mime_type: file.mimetype,
      size: file.size,
      path: normalizeStoredPath(file),
    }));

    await pool.query(
      `
        INSERT INTO job_applications (
          reference_no,
          first_name,
          middle_name,
          last_name,
          email,
          phone,
          alternative_phone,
          date_of_birth,
          gender,
          state_of_origin,
          local_government,
          house_address,
          post_applying_for,
          cv_path,
          supporting_document_path,
          certificates_json,
          declaration,
          submission_ip,
          user_agent
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        referenceNo,
        firstName,
        middleName,
        lastName,
        email,
        phone,
        alternativePhone,
        dateOfBirth,
        gender,
        stateOfOrigin,
        localGovernment,
        houseAddress,
        postApplyingFor,
        normalizeStoredPath(cv),
        normalizeStoredPath(otherDocument),
        JSON.stringify(certificatesPayload),
        1,
        req.ip || null,
        req.get("user-agent") || null,
      ],
    );

    return res.status(201).json({
      ok: true,
      message: "Application submitted successfully.",
      data: {
        reference_no: referenceNo,
        institution_name: INSTITUTION_NAME,
        submitted_at: submittedAt.toISOString(),
        submitted_at_display: new Intl.DateTimeFormat("en-NG", {
          dateStyle: "full",
          timeStyle: "medium",
        }).format(submittedAt),

        applicant_name: fullName,
        first_name: firstName,
        middle_name: middleName,
        last_name: lastName,
        gender,
        email,
        phone,
        alternative_phone: alternativePhone,
        date_of_birth: dateOfBirth,
        state_of_origin: stateOfOrigin,
        local_government: localGovernment,
        house_address: houseAddress,
        post_applying_for: postApplyingFor,

        uploads: {
          cv: cv
            ? {
                purpose: "Curriculum Vitae (CV)",
                original_name: cv.originalname,
              }
            : null,
          other_document: otherDocument
            ? {
                purpose: "Other Supporting Document",
                original_name: otherDocument.originalname,
              }
            : null,
          certificates: certificates.map((file) => ({
            purpose: "Educational Certificate",
            original_name: file.originalname,
          })),
        },
      },
    });
  } catch (error) {
    console.error("submitVacancyApplication error:", error);
    await cleanupUploadedFiles(req.files);

    return res.status(500).json({
      ok: false,
      message:
        "We could not submit your application right now. Please try again.",
    });
  }
}

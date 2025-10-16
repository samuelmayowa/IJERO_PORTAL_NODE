// app/core/status-policy.js

/* =========================
 * Status enums
 * =======================*/
export const STAFF_STATUS = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  SUSPENDED: 'SUSPENDED',
  LEAVE_OF_ABSENCE: 'LEAVE OF ABSENCE',
  SACKED: 'SACKED',
  TERMINATED: 'TERMINATED',
  RETIRED: 'RETIRED',
  RESIGNED: 'RESIGNED',
};

export const STUDENT_STATUS = {
  GRADUATED: 'GRADUATED',
  INACTIVE: 'INACTIVE',
  WITHDRAWN: 'WITHDRAWN',
  TRANSFERRED: 'TRANSFERRED',
  ABSCONDED: 'ABSCONDED',
};

/* =========================
 * Module keys
 * (use these keys in menus + route guards)
 * =======================*/
// Example student modules; adjust to match your project routes/menus.
export const STUDENT_MODULES = {
  PERSONAL: 'student.personal',
  RESULTS: 'student.results',       // transcripts/results
  FEES: 'student.fees',
  REGISTRATION: 'student.registration',
  COURSE_FORMS: 'student.courseforms',
  HOSTEL: 'student.hostel',
  MESSAGES: 'student.messages',
};

/* =========================
 * Policy helpers
 * =======================*/

// Can a user with (role, status) log in at all?
export function isLoginAllowed(status, role = '') {
  const r = String(role || '').toLowerCase();
  const s = String(status || '').toUpperCase();

  if (r === 'staff' || r === 'admin' || r === 'hod' || r === 'lecturer' || r === 'dean' ||
      r === 'ict' || r === 'bursary' || r === 'registry' || r === 'admission officer' ||
      r === 'auditor' || r === 'health center' || r === 'works' || r === 'library' ||
      r === 'provost' || r === 'student union') {
    // STAFF-like: ACTIVE + LOA + RETIRED can log in (LOA/RETIRED read-only)
    return (
      s === STAFF_STATUS.ACTIVE ||
      s === STAFF_STATUS.LEAVE_OF_ABSENCE ||
      s === STAFF_STATUS.RETIRED
    );
  }

  if (r === 'student') {
    // STUDENT:
    // - GRADUATED can log in (read-only limited modules)
    // - All other listed statuses cannot log in
    return s === STUDENT_STATUS.GRADUATED;
  }

  if (r === 'applicant') {
    // You can refine later; for now applicants are allowed (until you define applicant statuses)
    return true;
  }

  // Unknown roles: allow by default
  return true;
}

// Is the account read-only with this (role, status)?
export function isReadOnly(status, role = '') {
  const r = String(role || '').toLowerCase();
  const s = String(status || '').toUpperCase();

  if (r === 'student') {
    // GRADUATED: read-only (limited modules)
    return s === STUDENT_STATUS.GRADUATED;
  }

  // STAFF-like: LOA & RETIRED are read-only
  return s === STAFF_STATUS.LEAVE_OF_ABSENCE || s === STAFF_STATUS.RETIRED;
}

// Message shown when login is blocked due to status
export function blockedMessage(status, user = {}) {
  const role = String(user.role || '').toLowerCase();
  const s = String(status || '').toUpperCase();

  // STAFF-like messages
  if (role !== 'student' && role !== 'applicant') {
    if (s === STAFF_STATUS.INACTIVE || s === STAFF_STATUS.SUSPENDED) {
      return `Access Denied, you have been made ${s} by the admin. Please contact the ICT department.`;
    }
    if (s === STAFF_STATUS.SACKED) {
      return `Access Denied, you have been sacked. Any further attempt to access this system will be reported to the law enforcement agency(s).`;
    }
    if (s === STAFF_STATUS.TERMINATED) {
      return `Access Denied, you're not authorised. You have been terminated. Any further attempt to access this system will be reported to the law enforcement agency(s).`;
    }
    if (s === STAFF_STATUS.RESIGNED) {
      return `Access Denied, you have resigned. Please contact ICT if you believe this is an error.`;
    }
  }

  // STUDENT messages
  if (role === 'student') {
    if (s === STUDENT_STATUS.INACTIVE) {
      return `Access Denied. Your student account is INACTIVE. Please contact the ICT department.`;
    }
    if (s === STUDENT_STATUS.WITHDRAWN) {
      return `Access Denied. Your student record indicates WITHDRAWN status. Please contact the ICT department.`;
    }
    if (s === STUDENT_STATUS.TRANSFERRED) {
      return `Access Denied. Your student record indicates TRANSFERRED status.`;
    }
    if (s === STUDENT_STATUS.ABSCONDED) {
      return `Access Denied. Your student record indicates ABSCONDED status.`;
    }
  }

  return `Access Denied due to status: ${s || 'UNKNOWN'}. Please contact ICT.`;
}

// Message shown when a read-only user hits a write action
export function readOnlyActionMessage(user = {}) {
  const role = String(user.role || '').toLowerCase();
  const s = String(user.status || '').toUpperCase();
  const until = user.leaveUntil ? new Date(user.leaveUntil) : null;
  const untilText = until && !isNaN(until) ? until.toDateString() : null;

  if (role === 'student' && s === STUDENT_STATUS.GRADUATED) {
    return `Your account is GRADUATED. Only read-only access is available (personal info & results).`;
  }

  if (s === STAFF_STATUS.LEAVE_OF_ABSENCE) {
    return `You are on sabbatical leave${untilText ? ` until ${untilText}` : ''}. This feature is currently restricted right now.`;
  }
  if (s === STAFF_STATUS.RETIRED) {
    return `Your account is in RETIRED status. This feature is restricted.`;
  }
  return `This feature is restricted for your current status.`;
}

/* =========================
 * Module allowances in read-only state
 * =======================*/

// For students in GRADUATED status: allow only personal + results
export function allowedModules(role = '', status = '') {
  const r = String(role || '').toLowerCase();
  const s = String(status || '').toUpperCase();

  if (r === 'student' && s === STUDENT_STATUS.GRADUATED) {
    return new Set([STUDENT_MODULES.PERSONAL, STUDENT_MODULES.RESULTS]);
  }

  // Staff LOA/RETIRED: allow viewing everywhere; writes will be blocked per-route.
  return null; // null = no per-module filter needed
}

// Convenience: check if a module is usable under (role,status)
export function canUseModule(role = '', status = '', moduleKey = '') {
  const allow = allowedModules(role, status);
  if (!allow) return true; // no module restrictions configured
  return allow.has(moduleKey);
}

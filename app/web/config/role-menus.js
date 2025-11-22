// app/web/config/role-menus.js
//
// Role → allowed menu entries (and also used to render links).
// If a role is `null`, we don’t filter (full access). Otherwise, only the
// whitelisted items render/are allowed. Keep normalizePath helper below.

export const ROLE_MENUS = {
  // Admins: explicitly include the key links that were previously pointing
  // to generic "/staff" (causing blank pages). Everything else remains accessible
  // via your existing groups, but these ensure the correct hrefs.
  admin: [
    // Dashboard
    '/staff/dashboard',

    // Manage Session group
    { title: 'Manage Session', icon: 'fa fa-calendar', children: [
      { title: 'Set Current Session', href: '/staff/session/current'   },
      { title: 'Switch Semester',     href: '/staff/session/semester'  },
    ]},

    // Attendance Mgt group (keep your other attendance items as they are)
    { title: 'Attendance Mgt', icon: 'fa fa-users', children: [
      { title: 'Set Office Long/Lat.', href: '/staff/attendance/office-location' },
    ]},

    // Manage Staff group
    { title: 'Manage Staff', icon: 'fa fa-user', children: [
      { title: 'Assign Role to Staff', href: '/staff/manage/assign-role' },
      { title: 'Modify Staff',         href: '/staff/manage/modify'      },
    ]},
  ],

  superadmin: null,
  administrator: null,

  // Example HOD set kept from your current file
  hod: [
    '/staff/dashboard',
    '/transcripts/generate',
    '/results',
    '/transcripts/view',
    '/transcripts/send',
    '/records',
    '/staff/courses/add',
    '/staff/courses/assign',
    '/staff/students/utme',
    '/staff/students/attendance',
    '/staff/students/uniform',
    '/staff/exams/clearance/print',
    '/staff/signature/upload',
  ],
  lecturer: [
  '/staff/attendance/mark',
  '/staff/courses/assigned',   // ✅ Allow viewing assigned courses
  // other lecturer paths...
  ],
  staff: [
  '/staff/attendance/mark',
  '/staff/courses/assigned',   // ✅ Allow viewing assigned courses
  // other lecturer paths...
  ],


  // Others can keep full access for now (same as your current config)
  lecturer: null,
  dean: null,
  ict: null,
  bursary: null,
  registry: null,
  'admission officer': null,
  auditor: null,
  'health center': null,
  works: null,
  library: null,
  provost: null,
  'student union': null,

  student: null,
  applicant: null,
};

// Helper to normalize path comparisons (strip trailing slash)
export function normalizePath(p = '') {
  if (!p) return '/';
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

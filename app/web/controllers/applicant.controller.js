// app/web/controllers/applicant.controller.js

// If you already have a user service, you can wire it up later.
// For now we keep it minimal so the app boots and pages render.

export const showRegister = (req, res) => {
  // csrfToken is already in res.locals, no need to pass explicitly
  res.render('pages/register', { title: 'Applicant Registration' });
};

export const handleRegister = async (req, res) => {
  // TODO: persist applicant in your DB (user.service.js).
  // For now, just redirect to login with a flash message.
  req.flash('success', 'Account created. Please login.');
  return res.redirect('/login');
};

export function dashboard(req, res) {
  res.send('Applicant Dashboard');
}


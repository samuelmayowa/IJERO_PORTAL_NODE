// app/web/routes/staff.routes.js
import { Router } from 'express';
import * as staffCtrl from '../controllers/staff.controller.js';

const router = Router();

/** Helper: safely call a controller if it exists, otherwise respond 500 with a useful message. */
const safe = (fnName) => {
  const fn = staffCtrl?.[fnName];
  if (typeof fn === 'function') return fn;
  return (req, res) => {
    res
      .status(500)
      .send(`Controller "${fnName}" is not exported as a function from app/web/controllers/staff.controller.js`);
  };
};

/** Always render with AdminLTE layout to keep look & feel consistent */
router.use((req, res, next) => {
  res.locals.layout = 'layouts/adminlte';
  next();
});

/** Keep old links working */
router.get('/', (_req, res) => res.redirect('/staff/dashboard'));

/** Dashboard (existing page) */
router.get('/dashboard', safe('dashboard'));

/** Password Reset page + APIs */
router.get('/password-reset', safe('passwordResetPage'));                  // render page
router.get('/api/password/users', safe('listUsersForPasswordReset'));      // table data (paginated)
router.post('/api/password/reset/:id', safe('resetPasswordToCollege1'));   // reset to College1
router.post('/api/password/change', safe('changePasswordByAdmin'));        // admin sets custom password

export default router;

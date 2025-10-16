// app/web/routes/auth.routes.js
import { Router } from 'express';
import { getLogin, postLogin, logout } from '../controllers/auth.controller.js';

const router = Router();

// login
router.get('/login', getLogin);
router.post('/login', postLogin);

// logout — support BOTH GET and POST (your form posts; some users might hit URL directly)
router.get('/logout', logout);
router.post('/logout', logout);

export default router;

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const expressLayouts = require('express-ejs-layouts');

const isProd = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;
console.log('[startup] NODE_ENV:', process.env.NODE_ENV, '| SESSION_SECRET set:', !!sessionSecret, '| length:', (sessionSecret||'').length);
if (isProd && (!sessionSecret || sessionSecret === 'change-this-to-a-long-random-string')) {
  throw new Error(
    'SESSION_SECRET must be set to a real, random value in production. Generate one (e.g. `openssl rand -hex 32`) and set it in your .env.'
  );
}

const { requireAuth, requireAdmin } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const pipelineRoutes = require('./routes/pipeline');
const companiesRoutes = require('./routes/companies');
const productsRoutes = require('./routes/products');
const projectsRoutes = require('./routes/projects');
const tasksRoutes = require('./routes/tasks');
const activitiesRoutes = require('./routes/activities');
const contactsRoutes = require('./routes/contacts');
const dealsRoutes = require('./routes/deals');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');
const mediaRoutes   = require('./routes/media');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Public legal pages (no auth required)
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

app.use(
  session({
    store: new FileStore({ path: path.join(__dirname, '.sessions'), logFn: () => {} }),
    secret: sessionSecret || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
      secure: isProd,
      sameSite: 'lax'
    }
  })
);

if (isProd) {
  // Needed so secure cookies work correctly behind a reverse proxy / load balancer.
  app.set('trust proxy', 1);
}

// Make the logged-in user and email domain available to all views.
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.emailDomain = process.env.EMAIL_DOMAIN || 'mg.samyoucrm.com';
  // Helper for views: convert a Supabase storage_path to a /media/ URL
  res.locals.mediaUrl = (storagePath) =>
    storagePath ? `/media/${storagePath}` : null;
  next();
});

// Public routes — no auth required
app.use(authRoutes);
app.post('/login', authRoutes);   // handled inside authRoutes
// Mailgun inbound webhook — must be before requireAuth (no session cookie)
app.use(webhookRoutes);

// Media proxy — requires login, serves private Supabase Storage files
app.use(requireAuth);
app.use(mediaRoutes);

// Everything below requires login.
app.use(dashboardRoutes);
app.use(pipelineRoutes);
app.use(companiesRoutes);
app.use(productsRoutes);
app.use(projectsRoutes);
app.use(tasksRoutes);
app.use(activitiesRoutes);
app.use(contactsRoutes);
app.use(dealsRoutes);
app.use(apiRoutes);
app.use('/admin', requireAdmin, adminRoutes);

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Error', message: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CRM tracker running at http://localhost:${PORT}`);
});

require('dotenv').config();

const express       = require('express');
const session       = require('express-session');
const path          = require('path');
const migrate       = require('./db/migrate');
const authRoutes    = require('./routes/auth');
const adminRoutes   = require('./routes/admin');
const agentRoutes   = require('./routes/agent');
const fedapayRoutes = require('./routes/fedapay');
const cron          = require('node-cron');
const { lancerVirementsJournaliers } = require('./services/payoutService');

const app = express();

// ─── Corps des requêtes ─────────────────────────
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Fichiers statiques ─────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
// Uploads (reçus PDF temporaires)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── Sessions Express ───────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'sas_parking_secret_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24, httpOnly: true, sameSite: 'strict' }
}));

// ─── Moteur de vues EJS ─────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ─── Middleware global : variables partagées ────
app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});
const checkAbonnement = require('./middleware/checkAbonnement');
const abonnementRouter = require('./routes/abonnement');

app.use(checkAbonnement);          // ← avant toutes les routes
app.use('/', abonnementRouter);

// ─── Routes publiques ───────────────────────────
app.get('/', (req, res) => {
  // Si déjà connecté, rediriger
  if (req.session.userId)   return res.redirect('/dashboard');
  if (req.session.agentId)  return res.redirect('/agent/dashboard');
  res.render('auth/login', { error: null, success: req.query.success, formData: {} });
});

app.get('/signup', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('auth/signup', { error: null });
});

// ─── Routes applicatives ────────────────────────
app.use('/auth',  authRoutes);
app.use('/',      authRoutes);
app.use('/',      agentRoutes);
app.use('/',      adminRoutes);
app.use('/',      fedapayRoutes);

// ─── 404 ────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('pageIntrouvable');
});

// ─── Erreur globale ─────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERREUR GLOBALE]', err.stack);
  res.status(500).send('Erreur interne du serveur.');
});

// ─── Cron : virements journaliers à 22h00 ───────
cron.schedule('0 22 * * *', () => {
  console.log('[CRON] Lancement virements journaliers...');
  lancerVirementsJournaliers();
}, { timezone: 'Africa/Porto-Novo' });

// ─── Démarrage ──────────────────────────────────
const PORT = process.env.PORT || 3001;

migrate().then(() => {
  app.listen(PORT, () => {
    console.log(`✅  SAS Parking v2.0 démarré sur http://localhost:${PORT}`);
    console.log(`🗄   Base : ${process.env.DB_NAME}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`);
  });
}).catch(err => {
  console.error('❌  Impossible de démarrer :', err.message);
  process.exit(1);
});

module.exports = app;

const pool = require('../db/pool');

// Helper : heure actuelle en fuseau Bénin (Africa/Porto-Novo = UTC+1)
function getBeninHour() {
  const now = new Date();
  // UTC+1 fixe (Bénin ne change pas d'heure)
  const beninOffset = 60; // minutes
  const beninMs = now.getTime() + (beninOffset * 60 * 1000);
  const beninDate = new Date(beninMs);
  return { hour: beninDate.getUTCHours(), minute: beninDate.getUTCMinutes() };
}

function getBeninToday() {
  const now = new Date();
  const beninMs = now.getTime() + (60 * 60 * 1000); // UTC+1
  return new Date(beninMs).toISOString().split('T')[0];
}

module.exports = async function checkAbonnement(req, res, next) {

  // ── Déterminer si admin ou agent ──────────────────────────
  let siteId  = null;
  let isAdmin = false;
  let isAgent = false;

  if (req.session.userId) {
    siteId  = req.session.userId;
    isAdmin = true;
  } else if (req.session.agentId) {
    siteId  = req.session.agentSiteId;
    isAgent = true;
  } else {
    return next(); // non connecté → pas de vérification
  }

  // ── Pages exemptées ───────────────────────────────────────
  const exemptAdmin = ['/abonnement', '/abonnement/payer', '/logout', '/login', '/signup', '/reset'];
  const exemptAgent = ['/agent/login', '/agent/logout', '/agent/bloque'];
  const exempt = [...exemptAdmin, ...exemptAgent];

  if (exempt.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();

  // Assets statiques
  if (/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$/i.test(req.path)) return next();

  // ── Vérifier l'heure en Bénin ─────────────────────────────
  const { hour, minute } = getBeninHour();
  const apresDeclencement = (hour > 22) || (hour === 22 && minute >= 20);
  // Aussi après minuit jusqu'à 6h du matin (pour les nuits prolongées)
  const nuitProlongee = hour >= 0 && hour < 6;

  if (!apresDeclencement && !nuitProlongee) return next();

  // ── Vérification DB ───────────────────────────────────────
  try {
    const today = getBeninToday();

    // Abonnement payé aujourd'hui ?
    const { rows: paye } = await pool.query(
      `SELECT id FROM abonnements
       WHERE site_id = $1 AND statut = 'paye' AND date_echeance >= $2
       LIMIT 1`,
      [siteId, today]
    );
    if (paye.length > 0) return next();

    // Calculer CA du site aujourd'hui (même logique que l'original)
    const { rows: caRows } = await pool.query(
      `SELECT COALESCE(SUM(montant), 0) AS ca
       FROM sessions
       WHERE site_id = $1 AND DATE(heure_sortie) = $2 AND statut = 'cloture'`,
      [siteId, today]
    );
    const ca = parseFloat(caRows[0].ca || 0);

    // Pas de CA → pas de dette → laisser passer
    if (ca === 0) return next();

    // CA > 0 → créer ou récupérer l'abonnement du jour
    const { rows: existing } = await pool.query(
      `SELECT * FROM abonnements WHERE site_id = $1 AND date_echeance = $2
       ORDER BY created_at DESC LIMIT 1`,
      [siteId, today]
    );

    if (existing.length === 0) {
      const pourcentage = parseFloat(process.env.COMMISSION_PERCENT || 10);
      const montantDu   = parseFloat((ca * pourcentage / 100).toFixed(2));
      await pool.query(
        `INSERT INTO abonnements (site_id, montant, pourcentage, statut, date_echeance)
         VALUES ($1, $2, $3, 'en_attente', $4)`,
        [siteId, montantDu, pourcentage, today]
      );
    } else if (existing[0].statut === 'paye') {
      return next();
    }

    // ── Bloquer admin ou agent ────────────────────────────────
    if (isAgent) {
      // L'agent voit une page simple l'informant que l'admin doit payer
      return res.render('agent/bloque', {
        agentNom:    req.session.agentNom,
        agentPrenom: req.session.agentPrenom,
        agentSite:   req.session.agentSite
      });
    }

    // Admin → page de paiement
    return res.redirect('/abonnement');

  } catch (err) {
    console.error('[ABONNEMENT MIDDLEWARE]', err.message);
    return next(); // Ne jamais bloquer sur erreur DB
  }
};

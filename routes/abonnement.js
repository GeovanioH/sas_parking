const express = require('express');
const pool    = require('../db/pool');
const router  = express.Router();

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

router.get('/abonnement', requireAdmin, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const { rows } = await pool.query(
      `SELECT * FROM abonnements WHERE site_id = $1 AND date_echeance = $2 ORDER BY created_at DESC LIMIT 1`,
      [req.session.userId, today]
    );
    const abonnement = rows[0] || { montant: 0, pourcentage: parseFloat(process.env.COMMISSION_PERCENT || 10), statut: 'en_attente' };

    res.render('bloqu', {
      abonnement,
      adminNom:    req.session.userNom,
      adminPrenom: req.session.userPrenom,
      adminSite:   req.session.userSite,
      today
    });
  } catch (err) {
    console.error(err);
    res.render('bloqu', {
      abonnement: { montant: 0, pourcentage: parseFloat(process.env.COMMISSION_PERCENT || 10), statut: 'en_attente' },
      adminNom:    req.session.userNom,
      adminPrenom: req.session.userPrenom,
      adminSite:   req.session.userSite,
      today
    });
  }
});

router.post('/abonnement/payer', requireAdmin, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    await pool.query(
      `UPDATE abonnements SET statut = 'paye', paid_at = NOW()
       WHERE site_id = $1 AND date_echeance = $2`,
      [req.session.userId, today]
    );
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.redirect('/abonnement?error=Erreur lors du paiement.');
  }
});

module.exports = router;
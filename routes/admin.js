const express = require('express');
const bcrypt  = require('bcryptjs');
const pool    = require('../db/pool');
const router  = express.Router();

const SALT_ROUNDS = 10;

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

// ────────────────────────────────────────────────
// DASHBOARD ADMIN
// ────────────────────────────────────────────────
router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    // Stats globales du jour
    const statsRes = await pool.query(
      `SELECT
        SUM(COALESCE(montant,0)) AS recettes_jour,
        COUNT(*) AS sessions_jour,
        COUNT(CASE WHEN heure_sortie IS NULL AND deleted_at IS NULL THEN 1 END) AS velos_en_garde,
        COUNT(CASE WHEN statut='cloture' THEN 1 END) AS sessions_cloturees
       FROM sessions
       WHERE site_id = $1 AND DATE(heure_entree) = CURRENT_DATE`,
      [req.session.userId]
    );
    const stats = statsRes.rows[0] || {};

    // Agents actifs avec leurs stats
    const agentsRes = await pool.query(
      `SELECT a.id, a.nom, a.prenom, a.telephone,
              COUNT(s.id) AS nb_sessions,
              SUM(COALESCE(s.montant,0)) AS total_encaisse,
              COUNT(CASE WHEN s.heure_sortie IS NULL AND s.deleted_at IS NULL THEN 1 END) AS en_cours
       FROM agents a
       LEFT JOIN sessions s ON s.agent_id = a.id AND DATE(s.heure_entree) = CURRENT_DATE
       WHERE a.site_id = $1 AND a.deleted_at IS NULL AND a.actif = TRUE
       GROUP BY a.id, a.nom, a.prenom, a.telephone
       ORDER BY a.nom ASC`,
      [req.session.userId]
    );

    // Tarif actif
    const tarifRes = await pool.query(
      'SELECT * FROM tarifs WHERE site_id = $1 AND actif = TRUE ORDER BY created_at DESC LIMIT 1',
      [req.session.userId]
    );

    // Recettes par heure (aujourd'hui)
    const recettesHRes = await pool.query(
      `SELECT EXTRACT(HOUR FROM heure_sortie) AS heure,
              SUM(montant) AS total
       FROM sessions
       WHERE site_id = $1 AND DATE(heure_sortie) = CURRENT_DATE
         AND statut = 'cloture'
       GROUP BY EXTRACT(HOUR FROM heure_sortie)
       ORDER BY heure ASC`,
      [req.session.userId]
    );

    // Préparer données graphique (toutes les heures 0-23)
    const recettesChart = Array.from({ length: 24 }, (_, h) => {
      const found = recettesHRes.rows.find(r => Number(r.heure) === h);
      return { heure: h, total: found ? Number(found.total) : 0 };
    });

    res.render('admin/dashboard', {
      error:  null,
      success: req.query.success || null,
      adminNom:    req.session.userNom,
      adminPrenom: req.session.userPrenom,
      adminSite:   req.session.userSite,
      adminVille:  req.session.userVille,
      stats: {
        recettes_jour:       Number(stats.recettes_jour || 0).toFixed(0),
        velos_en_garde:      Number(stats.velos_en_garde || 0),
        sessions_jour:       Number(stats.sessions_jour || 0),
        sessions_cloturees:  Number(stats.sessions_cloturees || 0)
      },
      agents:       agentsRes.rows,
      currentTarif: tarifRes.rows[0] || null,
      recettesChart: JSON.stringify(recettesChart)
    });
  } catch (err) {
    console.error(err);
    res.render('admin/dashboard', {
      error: 'Erreur de chargement.',
      success: null,
      adminNom: req.session.userNom, adminPrenom: req.session.userPrenom,
      adminSite: req.session.userSite, adminVille: req.session.userVille,
      stats: { recettes_jour: 0, velos_en_garde: 0, sessions_jour: 0, sessions_cloturees: 0 },
      agents: [], currentTarif: null, recettesChart: '[]'
    });
  }
});

// ────────────────────────────────────────────────
// SAUVEGARDER TARIF
// ────────────────────────────────────────────────
router.post('/dashboard', requireAdmin, async (req, res) => {
  const mode  = req.body.mode;
  const prix  = parseFloat(req.body.prix);
  const heure = parseInt(req.body.heure, 10) || 0;

  if (!['heure', 'garde'].includes(mode) || isNaN(prix) || prix <= 0) {
    return res.redirect('/dashboard?error=Données invalides.');
  }

  try {
    await pool.query('UPDATE tarifs SET actif = FALSE WHERE site_id = $1', [req.session.userId]);
    await pool.query(
      `INSERT INTO tarifs (site_id, prix_par_heure, prix_minimum, mode_tarifaire, prix_tarif, heure_debut, actif)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
      [req.session.userId,
       mode === 'heure' ? prix : 0,
       mode === 'garde' ? prix : 0,
       mode, prix, heure]
    );
    res.redirect('/dashboard?success=Tarif enregistré avec succès.');
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard?error=Erreur lors de la sauvegarde.');
  }
});

// ────────────────────────────────────────────────
// PAGE AGENTS
// ────────────────────────────────────────────────
router.get('/agents', requireAdmin, async (req, res) => {
  const search = (req.query.search || '').trim();

  try {
    let query  = `SELECT a.*,
                    COUNT(s.id) AS total_sessions,
                    SUM(COALESCE(s.montant,0)) AS total_encaisse,
                    COUNT(CASE WHEN s.heure_sortie IS NULL AND s.deleted_at IS NULL THEN 1 END) AS en_cours
                  FROM agents a
                  LEFT JOIN sessions s ON s.agent_id = a.id AND DATE(s.heure_entree) = CURRENT_DATE
                  WHERE a.site_id = $1 AND a.deleted_at IS NULL`;
    const params = [req.session.userId];

    if (search) {
      query += ` AND (a.nom ILIKE $2 OR a.prenom ILIKE $2 OR a.telephone ILIKE $2)`;
      params.push(`%${search}%`);
    }

    query += ' GROUP BY a.id ORDER BY a.nom ASC';

    const { rows: agents } = await pool.query(query, params);

    res.render('admin/agents', {
      error:       req.query.error   || null,
      success:     req.query.success || null,
      adminNom:    req.session.userNom,
      adminPrenom: req.session.userPrenom,
      adminSite:   req.session.userSite,
      adminVille:  req.session.userVille,
      agents, search
    });
  } catch (err) {
    console.error(err);
    res.render('admin/agents', {
      error: 'Erreur de connexion.', success: null,
      adminNom: req.session.userNom, adminPrenom: req.session.userPrenom,
      adminSite: req.session.userSite, adminVille: req.session.userVille,
      agents: [], search
    });
  }
});

// ────────────────────────────────────────────────
// CRÉER UN AGENT
// ────────────────────────────────────────────────
router.post('/agents/create', requireAdmin, async (req, res) => {
  const { nom, prenom, telephone, mot_de_passe } = req.body;

  if (!nom || !prenom || !telephone || !mot_de_passe) {
    return res.redirect('/agents?error=Tous les champs sont obligatoires.');
  }
  if (mot_de_passe.length < 6) {
    return res.redirect('/agents?error=Le mot de passe doit faire au moins 6 caractères.');
  }

  try {
    const hash = await bcrypt.hash(mot_de_passe, SALT_ROUNDS);
    await pool.query(
      'INSERT INTO agents (site_id, nom, prenom, telephone, mot_de_passe, actif) VALUES ($1,$2,$3,$4,$5,TRUE)',
      [req.session.userId, nom.trim(), prenom.trim(), telephone.trim(), hash]
    );
    res.redirect('/agents?success=Agent créé avec succès.');
  } catch (err) {
    const msg = err.code === '23505'
      ? 'Ce numéro de téléphone est déjà utilisé.'
      : 'Erreur lors de la création de l\'agent.';
    res.redirect('/agents?error=' + encodeURIComponent(msg));
  }
});

// ────────────────────────────────────────────────
// SUPPRIMER UN AGENT (soft delete)
// ────────────────────────────────────────────────
router.post('/agents/delete/:id', requireAdmin, async (req, res) => {
  const agentId = parseInt(req.params.id, 10);
  if (!agentId) return res.redirect('/agents?error=ID invalide.');

  try {
    await pool.query(
      'UPDATE agents SET deleted_at = NOW(), actif = FALSE WHERE id = $1 AND site_id = $2',
      [agentId, req.session.userId]
    );
    res.redirect('/agents?success=Agent supprimé avec succès.');
  } catch (err) {
    res.redirect('/agents?error=Erreur lors de la suppression.');
  }
});

// ────────────────────────────────────────────────
// RÉACTIVER UN AGENT
// ────────────────────────────────────────────────
router.post('/agents/toggle/:id', requireAdmin, async (req, res) => {
  const agentId = parseInt(req.params.id, 10);

  try {
    const { rows } = await pool.query('SELECT actif FROM agents WHERE id = $1 AND site_id = $2', [agentId, req.session.userId]);
    if (!rows.length) return res.redirect('/agents?error=Agent non trouvé.');

    const newStatus = !rows[0].actif;
    await pool.query('UPDATE agents SET actif = $1, deleted_at = NULL WHERE id = $2', [newStatus, agentId]);
    const msg = newStatus ? 'Agent réactivé.' : 'Agent désactivé.';
    res.redirect('/agents?success=' + encodeURIComponent(msg));
  } catch (err) {
    res.redirect('/agents?error=Erreur.');
  }
});

// ────────────────────────────────────────────────
// PAGE RAPPORTS
// ────────────────────────────────────────────────
router.get('/rapports', requireAdmin, async (req, res) => {
  const periodeRaw = req.query.periode    || '30';
  const dateDebut  = req.query.date_debut || '';
  const dateFin    = req.query.date_fin   || '';
  const periodeInt = parseInt(periodeRaw, 10);
  const periode    = (!isNaN(periodeInt) && periodeInt >= 1 && periodeInt <= 365) ? String(periodeInt) : '30';

  try {
    const params = [req.session.userId];
    let condDate;

    if (dateDebut && dateFin) {
      condDate = `DATE(heure_entree) BETWEEN $2 AND $3`;
      params.push(dateDebut, dateFin);
    } else {
      const p = parseInt(periode, 10);
      condDate = `DATE(heure_entree) >= CURRENT_DATE - INTERVAL '${p} days'`;
    }

    // Total période
    const totalRes = await pool.query(
      `SELECT
        SUM(COALESCE(montant,0)) AS total_recettes,
        COUNT(*) AS total_sessions,
        COUNT(CASE WHEN mode_paiement='mobile_money' THEN 1 END) AS nb_mobile,
        COUNT(CASE WHEN mode_paiement='especes' THEN 1 END) AS nb_especes,
        SUM(CASE WHEN mode_paiement='mobile_money' THEN COALESCE(montant,0) ELSE 0 END) AS total_mobile,
        SUM(CASE WHEN mode_paiement='especes' THEN COALESCE(montant,0) ELSE 0 END) AS total_especes
       FROM sessions
       WHERE site_id = $1 AND statut = 'cloture' AND deleted_at IS NULL
         AND ${condDate}`,
      params
    );

    // Par jour
    const parJourRes = await pool.query(
      `SELECT DATE(heure_entree) AS jour, SUM(COALESCE(montant,0)) AS total, COUNT(*) AS nb
       FROM sessions
       WHERE site_id = $1 AND statut = 'cloture' AND deleted_at IS NULL
         AND ${condDate}
       GROUP BY DATE(heure_entree)
       ORDER BY jour ASC`,
      params
    );

    // Par agent
    const parAgentRes = await pool.query(
      `SELECT a.nom || ' ' || a.prenom AS nom_agent,
              COUNT(s.id) AS nb_sessions,
              SUM(COALESCE(s.montant,0)) AS total
       FROM sessions s JOIN agents a ON s.agent_id = a.id
       WHERE s.site_id = $1 AND s.statut = 'cloture' AND s.deleted_at IS NULL
         AND ${condDate}
       GROUP BY a.id, a.nom, a.prenom
       ORDER BY total DESC`,
      params
    );

    // Dernières sessions
    const dernieresRes = await pool.query(
      `SELECT s.*, a.nom AS agent_nom
       FROM sessions s JOIN agents a ON s.agent_id = a.id
       WHERE s.site_id = $1 AND s.statut = 'cloture' AND s.deleted_at IS NULL
       ORDER BY s.heure_sortie DESC LIMIT 20`,
      [req.session.userId]
    );

    const total = totalRes.rows[0] || {};

    res.render('admin/rapports', {
      error: null,
      adminNom:    req.session.userNom,
      adminPrenom: req.session.userPrenom,
      adminSite:   req.session.userSite,
      adminVille:  req.session.userVille,
      periode, dateDebut, dateFin,
      total: {
        recettes:      Number(total.total_recettes || 0).toFixed(0),
        sessions:      Number(total.total_sessions || 0),
        nb_mobile:     Number(total.nb_mobile || 0),
        nb_especes:    Number(total.nb_especes || 0),
        total_mobile:  Number(total.total_mobile || 0).toFixed(0),
        total_especes: Number(total.total_especes || 0).toFixed(0)
      },
      parJourChart: JSON.stringify(parJourRes.rows),
      parAgentData: parAgentRes.rows,
      dernieres:    dernieresRes.rows
    });
  } catch (err) {
    console.error(err);
    res.render('admin/rapports', {
      error: 'Erreur de chargement.',
      adminNom: req.session.userNom, adminPrenom: req.session.userPrenom,
      adminSite: req.session.userSite, adminVille: req.session.userVille,
      periode, dateDebut, dateFin,
      total: { recettes: 0, sessions: 0, nb_mobile: 0, nb_especes: 0, total_mobile: 0, total_especes: 0 },
      parJourChart: '[]', parAgentData: [], dernieres: []
    });
  }
});

// ────────────────────────────────────────────────
// PAGE PARAMÈTRES
// ────────────────────────────────────────────────
router.get('/parametres', requireAdmin, async (req, res) => {
  try {
    const siteRes = await pool.query('SELECT * FROM sites WHERE id = $1', [req.session.userId]);
    const tarifRes = await pool.query(
      'SELECT * FROM tarifs WHERE site_id = $1 ORDER BY created_at DESC LIMIT 5',
      [req.session.userId]
    );

    res.render('admin/parametres', {
      error:  req.query.error   || null,
      success: req.query.success || null,
      adminNom: req.session.userNom, adminPrenom: req.session.userPrenom,
      adminSite: req.session.userSite, adminVille: req.session.userVille,
      site:    siteRes.rows[0] || {},
      tarifs:  tarifRes.rows
    });
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard');
  }
});

// ────────────────────────────────────────────────
// METTRE À JOUR LES PARAMÈTRES DU SITE
// ────────────────────────────────────────────────
router.post('/parametres', requireAdmin, async (req, res) => {
  const { nom_parking, ville, capacite } = req.body;

  if (!nom_parking || !ville) {
    return res.redirect('/parametres?error=Nom et ville sont requis.');
  }

  try {
    await pool.query(
      'UPDATE sites SET nom_parking = $1, ville = $2, capacite = $3 WHERE id = $4',
      [nom_parking.trim(), ville.trim(), parseInt(capacite || 50), req.session.userId]
    );
    req.session.userSite  = nom_parking.trim();
    req.session.userVille = ville.trim();
    res.redirect('/parametres?success=Paramètres mis à jour.');
  } catch (err) {
    res.redirect('/parametres?error=Erreur lors de la mise à jour.');
  }
});

// ────────────────────────────────────────────────
// HISTORIQUE SESSIONS ADMIN (toutes les sessions)
// ────────────────────────────────────────────────
router.get('/historique', requireAdmin, async (req, res) => {
  const search  = (req.query.search || '').trim();
  const filtre  = req.query.filtre  || 'toutes';
  const agentId = req.query.agent   || '';
  const date    = req.query.date    || '';

  try {
    let query = `SELECT s.*, a.nom AS agent_nom, a.prenom AS agent_prenom
                 FROM sessions s JOIN agents a ON s.agent_id = a.id
                 WHERE s.site_id = $1 AND s.deleted_at IS NULL`;
    const params = [req.session.userId];
    let idx = 2;

    if (search) {
      query += ` AND (s.plaque ILIKE $${idx} OR s.code_hex ILIKE $${idx})`;
      params.push(`%${search}%`); idx++;
    }
    if (agentId) {
      query += ` AND s.agent_id = $${idx}`;
      params.push(parseInt(agentId)); idx++;
    }
    if (filtre === 'en_cours') query += ` AND s.statut = 'en_cours'`;
    if (filtre === 'cloture')  query += ` AND s.statut = 'cloture'`;
    if (date) {
      query += ` AND DATE(s.heure_entree) = $${idx}`;
      params.push(date); idx++;
    }

    query += ' ORDER BY s.heure_entree DESC LIMIT 200';

    const { rows: sessions } = await pool.query(query, params);
    const { rows: agents }   = await pool.query(
      'SELECT id, nom, prenom FROM agents WHERE site_id = $1 AND deleted_at IS NULL ORDER BY nom',
      [req.session.userId]
    );

    res.render('admin/historique', {
      error: null, sessions, search, filtre, agentId, date, agents,
      adminNom: req.session.userNom, adminPrenom: req.session.userPrenom,
      adminSite: req.session.userSite, adminVille: req.session.userVille
    });
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard');
  }
});

module.exports = router;

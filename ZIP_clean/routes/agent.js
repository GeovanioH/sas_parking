const express = require('express');
const pool = require('../db/pool');
const router = express.Router();
const { genererCodeHex } = require('../services/codeHex');
const { notifierEntree, notifierSortie } = require('../services/notification');
const { genererRecuPDF, sauvegarderRecuEnDB, getRecuFromDB } = require('../services/ticket');

function requireAgent(req, res, next) {
  if (!req.session.agentId) return res.redirect('/agent/login');
  next();
}

// ────────────────────────────────────────────────
// DASHBOARD AGENT
// ────────────────────────────────────────────────
router.get('/agent/dashboard', requireAgent, async (req, res) => {
  try {
    // Tarif actif
    const tarifRes = await pool.query(
      'SELECT * FROM tarifs WHERE site_id = $1 AND actif = TRUE ORDER BY created_at DESC LIMIT 1',
      [req.session.agentSiteId]
    );
    const currentTarif = tarifRes.rows[0] || null;

    // Stats du jour
    const statsRes = await pool.query(
      `SELECT
        COUNT(*) AS total_entrees,
        COUNT(CASE WHEN heure_sortie IS NOT NULL THEN 1 END) AS total_sorties,
        SUM(COALESCE(montant, 0)) AS caisse_actuelle,
        COUNT(CASE WHEN statut = 'en_cours' THEN 1 END) AS en_cours
       FROM sessions
       WHERE agent_id = $1 AND deleted_at IS NULL AND DATE(heure_entree) = CURRENT_DATE`,
      [req.session.agentId]
    );
    const stats = statsRes.rows[0] || {};

    // Sessions récentes (10 dernières)
    const sessionsRes = await pool.query(
      `SELECT id, nom_client, prenom_client, plaque, code_hex,
              heure_entree, heure_sortie, montant, statut, mode_paiement
       FROM sessions
       WHERE agent_id = $1 AND deleted_at IS NULL
       ORDER BY heure_entree DESC
       LIMIT 10`,
      [req.session.agentId]
    );

    // Sessions en cours (pour le tableau principal)
    const enCoursRes = await pool.query(
      `SELECT id, nom_client, prenom_client, plaque, code_hex, heure_entree
       FROM sessions
       WHERE agent_id = $1 AND deleted_at IS NULL AND heure_sortie IS NULL
       ORDER BY heure_entree ASC`,
      [req.session.agentId]
    );

    res.render('agent/dashboard', {
      error: null,
      agentNom: req.session.agentNom,
      agentPrenom: req.session.agentPrenom,
      agentTelephone: req.session.agentTelephone,
      agentSite: req.session.agentSite,
      agentVille: req.session.agentVille,
      stats: {
        total_entrees: Number(stats.total_entrees || 0),
        total_sorties: Number(stats.total_sorties || 0),
        caisse_actuelle: Number(stats.caisse_actuelle || 0).toFixed(0),
        en_cours: Number(stats.en_cours || 0)
      },
      currentTarif,
      sessionsRecentes: sessionsRes.rows,
      sessionsEnCours: enCoursRes.rows
    });
  } catch (err) {
    console.error(err);
    res.render('agent/dashboard', {
      error: 'Erreur chargement tableau de bord.',
      agentNom: req.session.agentNom, agentPrenom: req.session.agentPrenom,
      agentTelephone: req.session.agentTelephone,
      agentSite: req.session.agentSite, agentVille: req.session.agentVille,
      stats: { total_entrees: 0, total_sorties: 0, caisse_actuelle: 0, en_cours: 0 },
      currentTarif: null, sessionsRecentes: [], sessionsEnCours: []
    });
  }
});

// ────────────────────────────────────────────────
// PAGE ENREGISTREMENT ENTRÉE
// ────────────────────────────────────────────────
router.get('/agent/entree', requireAgent, async (req, res) => {
  try {
    // Capacité et occupation
    const siteRes = await pool.query(
      'SELECT capacite FROM sites WHERE id = $1',
      [req.session.agentSiteId]
    );
    const capacite = siteRes.rows[0]?.capacite || 50;

    const occupationRes = await pool.query(
      'SELECT COUNT(*) AS nb FROM sessions WHERE site_id = $1 AND heure_sortie IS NULL AND deleted_at IS NULL',
      [req.session.agentSiteId]
    );
    const occupation = Number(occupationRes.rows[0]?.nb || 0);

    // 5 dernières entrées
    const dernieresRes = await pool.query(
      `SELECT plaque, heure_entree, code_hex FROM sessions
       WHERE agent_id = $1 AND deleted_at IS NULL
       ORDER BY heure_entree DESC LIMIT 5`,
      [req.session.agentId]
    );

    res.render('agent/entree', {
      error: null, success: null,
      agentNom: req.session.agentNom, agentPrenom: req.session.agentPrenom,
      agentSite: req.session.agentSite, agentVille: req.session.agentVille,
      capacite, occupation,
      dernieres: dernieresRes.rows,
      formData: {}
    });
  } catch (err) {
    console.error(err);
    res.render('agent/entree', {
      error: 'Erreur chargement page.', success: null,
      agentNom: req.session.agentNom, agentPrenom: req.session.agentPrenom,
      agentSite: req.session.agentSite, agentVille: req.session.agentVille,
      capacite: 50, occupation: 0, dernieres: [], formData: {}
    });
  }
});

// ────────────────────────────────────────────────
// ENREGISTRER UNE ENTRÉE (POST)
// ────────────────────────────────────────────────
router.post('/agent/entree', requireAgent, async (req, res) => {
  const plaque = (req.body.plaque || '').trim().toUpperCase();
  const nom = (req.body.nom || '').trim();
  const prenom = (req.body.prenom || '').trim();
  const telephone = (req.body.telephone || '').trim();
  const numero_cip = (req.body.numero_cip || '').trim();
  const mode = (req.body.mode || 'especes').trim();

  if (!plaque) {
    return res.render('agent/entree', {
      error: 'La plaque est obligatoire.',
      success: null,
      agentNom: req.session.agentNom, agentPrenom: req.session.agentPrenom,
      agentSite: req.session.agentSite, agentVille: req.session.agentVille,
      capacite: 50, occupation: 0, dernieres: [],
      formData: { plaque, nom, prenom, telephone, numero_cip, mode }
    });
  }

  const paymentMode = mode === 'mobile' ? 'mobile_money' : 'especes';

  try {
    // Générer un code hex unique
    let code_hex, hexExists;
    do {
      code_hex = genererCodeHex();
      const check = await pool.query('SELECT id FROM sessions WHERE code_hex = $1', [code_hex]);
      hexExists = check.rows.length > 0;
    } while (hexExists);
    // Vérifier doublons plaque en cours
    const doublon = await pool.query(
      'SELECT id FROM sessions WHERE site_id = $1 AND plaque = $2 AND heure_sortie IS NULL AND deleted_at IS NULL',
      [req.session.agentSiteId, plaque]
    );
    if (doublon.rows.length > 0) {
      return res.render('agent/entree', {
        error: `La plaque ${plaque} est déjà enregistrée en cours de garde.`,
        success: null,
        agentNom: req.session.agentNom, agentPrenom: req.session.agentPrenom,
        agentSite: req.session.agentSite, agentVille: req.session.agentVille,
        capacite: 50, occupation: 0, dernieres: [],
        formData: { plaque, nom, prenom, telephone, numero_cip, mode }
      });
    }

    // Insérer la session avec code_hex
    const insertRes = await pool.query(
      `INSERT INTO sessions
        (site_id, agent_id, nom_client, prenom_client, telephone_client,
         plaque, numero_cip, code_hex, mode_paiement, statut)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'en_cours')
       RETURNING *`,
      [req.session.agentSiteId, req.session.agentId,
        nom, prenom, telephone, plaque,
      numero_cip || null, code_hex, paymentMode]
    );

    const newSession = insertRes.rows[0];

    // Envoyer notification SMS d'entrée
    if (telephone) {
      notifierEntree({
        id: newSession.id,
        plaque: newSession.plaque,
        code_hex: newSession.code_hex,
        telephone_client: newSession.telephone_client
      }).catch(e => console.error('[NOTIF-ENTREE]', e.message));
    }

    // Rediriger avec confirmation
    res.redirect(`/agent/entree?success=1&code=${code_hex}&plaque=${plaque}`);
  } catch (err) {
    console.error(err);
    res.render('agent/entree', {
      error: 'Erreur lors de l\'enregistrement. Réessayez.',
      success: null,
      agentNom: req.session.agentNom, agentPrenom: req.session.agentPrenom,
      agentSite: req.session.agentSite, agentVille: req.session.agentVille,
      capacite: 50, occupation: 0, dernieres: [],
      formData: { plaque, nom, prenom, telephone, numero_cip, mode }
    });
  }
});

// ────────────────────────────────────────────────
// PAGE LISTE DES SESSIONS / HISTORIQUE
// ────────────────────────────────────────────────
router.get('/agent/sessions', requireAgent, async (req, res) => {
  const search = (req.query.search || '').trim();
  const filtre = req.query.filtre || 'toutes';
  const date = req.query.date || '';

  try {
    let query = `SELECT s.*, s.nom_client || ' ' || s.prenom_client AS nom_complet
                  FROM sessions s
                  WHERE s.agent_id = $1 AND s.deleted_at IS NULL`;
    const params = [req.session.agentId];
    let idx = 2;

    if (search) {
      query += ` AND (s.plaque ILIKE $${idx} OR s.code_hex ILIKE $${idx} OR s.nom_client ILIKE $${idx})`;
      params.push(`%${search}%`); idx++;
    }
    if (filtre === 'en_cours') { query += ` AND s.statut = 'en_cours'`; }
    if (filtre === 'termine') { query += ` AND s.statut = 'cloture'`; }
    if (filtre === 'mobile') { query += ` AND s.mode_paiement = 'mobile_money'`; }
    if (filtre === 'especes') { query += ` AND s.mode_paiement = 'especes'`; }
    if (date) {
      query += ` AND DATE(s.heure_entree) = $${idx}`;
      params.push(date); idx++;
    }

    query += ' ORDER BY s.heure_entree DESC LIMIT 100';

    const { rows: sessions } = await pool.query(query, params);

    // Totaux
    const totauxRes = await pool.query(
      `SELECT COUNT(*) AS nb, SUM(COALESCE(montant,0)) AS total_montant,
              COUNT(CASE WHEN mode_paiement='mobile_money' THEN 1 END) AS nb_mobile,
              COUNT(CASE WHEN mode_paiement='especes' THEN 1 END) AS nb_especes
       FROM sessions WHERE agent_id = $1 AND deleted_at IS NULL AND DATE(heure_entree) = CURRENT_DATE`,
      [req.session.agentId]
    );
    const totaux = totauxRes.rows[0] || {};

    res.render('agent/sessions', {
      error: null, sessions, search, filtre, date,
      agentNom: req.session.agentNom, agentPrenom: req.session.agentPrenom,
      agentSite: req.session.agentSite, agentVille: req.session.agentVille,
      totaux: {
        nb: Number(totaux.nb || 0),
        total: Number(totaux.total_montant || 0).toFixed(0),
        nb_mobile: Number(totaux.nb_mobile || 0),
        nb_especes: Number(totaux.nb_especes || 0)
      }
    });
  } catch (err) {
    console.error(err);
    res.render('agent/sessions', {
      error: 'Erreur de chargement.', sessions: [],
      search, filtre, date,
      agentNom: req.session.agentNom, agentPrenom: req.session.agentPrenom,
      agentSite: req.session.agentSite, agentVille: req.session.agentVille,
      totaux: { nb: 0, total: 0, nb_mobile: 0, nb_especes: 0 }
    });
  }
});


// ────────────────────────────────────────────────
// PAGE TRAITEMENT SORTIE (GET)
// ────────────────────────────────────────────────
router.get('/agent/sortie', requireAgent, async (req, res) => {
  const plaque = (req.query.plaque || '').trim().toUpperCase();
  const code = (req.query.code || '').trim().toUpperCase();
  let session = null;
  let montant = null;
  let tarif = null;
  let error = null;

  if (plaque || code) {
    try {
      let whereClause = 's.site_id = $1 AND s.heure_sortie IS NULL AND s.deleted_at IS NULL';
      const params = [req.session.agentSiteId];

      if (code) {
        whereClause += ' AND s.code_hex = $2';
        params.push(code);
      } else {
        whereClause += ' AND s.plaque = $2';
        params.push(plaque);
      }

      const sessRes = await pool.query(
        `SELECT s.*, a.nom AS agent_nom, a.prenom AS agent_prenom
         FROM sessions s
         JOIN agents a ON s.agent_id = a.id
         WHERE ${whereClause} LIMIT 1`,
        params
      );

      if (sessRes.rows.length) {
        session = sessRes.rows[0];

        // Calculer le tarif
        const tarifRes = await pool.query(
          'SELECT * FROM tarifs WHERE site_id = $1 AND actif = TRUE ORDER BY created_at DESC LIMIT 1',
          [req.session.agentSiteId]
        );
        tarif = tarifRes.rows[0] || null;

        if (tarif) {
          const now = new Date();
          const entree = new Date(session.heure_entree);
          const diffMs = now - entree;
          const diffH = diffMs / (1000 * 60 * 60);
          const prix = parseFloat(tarif.prix_tarif);
          montant = tarif.mode_tarifaire === 'garde'
            ? prix
            : Math.max(1, Math.ceil(diffH)) * prix;
        }
      } else {
        error = 'Aucun véhicule en cours trouvé pour cette plaque / code.';
      }
    } catch (err) {
      console.error(err);
      error = 'Erreur lors de la recherche.';
    }
  }

  res.render('agent/sortie', {
    error, session, montant, tarif, plaque, code,
    agentNom: req.session.agentNom,
    agentPrenom: req.session.agentPrenom,
    agentSite: req.session.agentSite,
    agentVille: req.session.agentVille,
    fedapayPublicKey: process.env.FEDAPAY_PUBLIC_KEY || ''
  });
});

// ────────────────────────────────────────────────
// CONFIRMER SORTIE ET GÉNÉRER LE REÇU (POST)
// ────────────────────────────────────────────────
router.post('/agent/sortie/:id', requireAgent, async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  const mode = req.body.mode || 'especes';
  if (!sessionId) return res.redirect('/agent/sortie?error=ID invalide.');

  try {
    // Récupérer la session + site
    const sessRes = await pool.query(
      `SELECT s.*, a.nom AS agent_nom
       FROM sessions s JOIN agents a ON s.agent_id = a.id
       WHERE s.id = $1 AND s.site_id = $2 AND s.deleted_at IS NULL AND s.heure_sortie IS NULL`,
      [sessionId, req.session.agentSiteId]
    );

    if (!sessRes.rows.length) {
      return res.redirect('/agent/sortie?error=Session introuvable ou déjà clôturée.');
    }

    const session = sessRes.rows[0];
    const heureSortie = new Date();
    const heureEntree = new Date(session.heure_entree);

    // Récupérer tarif
    const tarifRes = await pool.query(
      'SELECT * FROM tarifs WHERE site_id = $1 AND actif = TRUE ORDER BY created_at DESC LIMIT 1',
      [req.session.agentSiteId]
    );
    const tarif = tarifRes.rows[0] || null;

    let montant = 0;
    if (tarif) {
      const prix = parseFloat(tarif.prix_tarif);
      const diffMs = heureSortie - heureEntree;
      const diffH = diffMs / (1000 * 60 * 60);
      montant = tarif.mode_tarifaire === 'garde'
        ? prix
        : Math.max(1, Math.ceil(diffH)) * prix;
    }

    const paymentMode = mode === 'mobile' ? 'mobile_money' : 'especes';

    // ── Si Mobile Money → créer transaction FedaPay et rediriger ──
    if (paymentMode === 'mobile_money') {
      const { creerTransaction } = require('../services/paymentService');
      const fedaResult = await creerTransaction({
        montant,
        telephone: session.telephone_client || '',
        description: `Parking ${session.plaque} - Session #${sessionId}`,
        sessionId
      });

      const statutPaiement = fedaResult.success ? 'en_attente' : 'echoue';
      const refFedapay = fedaResult.simulated ? null : String(fedaResult.transactionId || '');

      // Enregistrer le paiement (une seule fois)
      await pool.query(
        `INSERT INTO paiements (session_id, montant, mode, statut, reference_fedapay)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, montant, paymentMode, statutPaiement, refFedapay]
      );

      // Mettre à jour heure_sortie et montant sur la session
      await pool.query(
        `UPDATE sessions SET heure_sortie = NOW(), montant = $1, mode_paiement = $2
         WHERE id = $3`,
        [montant, paymentMode, sessionId]
      );

      // Si paiement en ligne réel → rediriger vers FedaPay
      if (fedaResult.paymentUrl && !fedaResult.simulated) {
        return res.redirect(fedaResult.paymentUrl);
      }

      // Simulation ou erreur → clôturer directement
      await pool.query(
        `UPDATE sessions SET statut = 'cloture' WHERE id = $1`,
        [sessionId]
      );
      return res.redirect(`/agent/sortie/confirme/${sessionId}?montant=${montant}&mode=${paymentMode}`);
    }

    // Récupérer infos site
    const siteRes = await pool.query('SELECT * FROM sites WHERE id = $1', [req.session.agentSiteId]);
    const site = siteRes.rows[0];

    // Générer le reçu PDF
    let pdfBase64 = null;
    try {
      const pdfData = await genererRecuPDF(
        { ...session, heure_sortie: heureSortie, montant, mode_paiement: paymentMode, agent_nom: req.session.agentNom },
        site,
        tarif
      );
      if (pdfData) {
        pdfBase64 = pdfData.base64;
      }
    } catch (pdfErr) {
      console.error('[PDF] Erreur génération :', pdfErr.message);
    }

    // Mettre à jour la session
    await pool.query(
      `UPDATE sessions
       SET heure_sortie = $1, statut = 'cloture', montant = $2,
           mode_paiement = $3, pdf_recu = $4
       WHERE id = $5 AND agent_id = $6`,
      [heureSortie, montant, paymentMode, pdfBase64, sessionId, req.session.agentId]
    );

    // Enregistrer le paiement
    await pool.query(
      `INSERT INTO paiements (session_id, montant, mode, statut, paid_at)
       VALUES ($1, $2, $3, 'confirme', NOW())`,
      [sessionId, montant, paymentMode]
    );

    // Envoyer notification SMS de sortie
    if (session.telephone_client) {
      notifierSortie(
        { ...session, heure_sortie: heureSortie },
        montant
      ).catch(e => console.error('[NOTIF-SORTIE]', e.message));
    }

    res.redirect(`/agent/sortie/confirme/${sessionId}?montant=${montant}&mode=${paymentMode}`);
  } catch (err) {
    console.error(err);
    res.redirect('/agent/sortie?error=Erreur lors de la clôture de la session.');
  }
});

// ────────────────────────────────────────────────
// PAGE CONFIRMATION SORTIE
// ────────────────────────────────────────────────
router.get('/agent/sortie/confirme/:id', requireAgent, async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);

  try {
    const { rows } = await pool.query(
      `SELECT s.*, a.nom AS agent_nom, si.nom_parking, si.ville
       FROM sessions s
       JOIN agents a ON s.agent_id = a.id
       JOIN sites si ON s.site_id = si.id
       WHERE s.id = $1`,
      [sessionId]
    );

    if (!rows.length) return res.redirect('/agent/dashboard');

    const session = rows[0];
    const hasPdf = !!session.pdf_recu;

    res.render('agent/confirmation', {
      session, hasPdf,
      montant: req.query.montant || session.montant,
      mode: req.query.mode || session.mode_paiement,
      agentNom: req.session.agentNom, agentPrenom: req.session.agentPrenom,
      agentSite: req.session.agentSite, agentVille: req.session.agentVille
    });
  } catch (err) {
    console.error(err);
    res.redirect('/agent/dashboard');
  }
});

// ────────────────────────────────────────────────
// TÉLÉCHARGER LE REÇU PDF
// ────────────────────────────────────────────────
router.get('/agent/recu/:id', requireAgent, async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);

  try {
    const { rows } = await pool.query(
      'SELECT pdf_recu, plaque, code_hex FROM sessions WHERE id = $1 AND site_id = $2',
      [sessionId, req.session.agentSiteId]
    );

    if (!rows.length || !rows[0].pdf_recu) {
      return res.status(404).send('Reçu non disponible.');
    }

    const session = rows[0];
    const buffer = Buffer.from(session.pdf_recu, 'base64');
    const nomFichier = `recu-${session.plaque}-${session.code_hex}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomFichier}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur lors de la génération du reçu.');
  }
});

// ────────────────────────────────────────────────
// ANNULER UNE SESSION
// ────────────────────────────────────────────────
router.post('/agent/session/annuler/:id', requireAgent, async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);

  try {
    await pool.query(
      `UPDATE sessions SET statut = 'annule', deleted_at = NOW()
       WHERE id = $1 AND agent_id = $2 AND heure_sortie IS NULL`,
      [sessionId, req.session.agentId]
    );
    res.redirect('/agent/sessions?success=Session annulée.');
  } catch (err) {
    console.error(err);
    res.redirect('/agent/sessions?error=Erreur lors de l\'annulation.');
  }
});

// ────────────────────────────────────────────────
// DÉTAIL D'UNE SESSION (modal/page)
// ────────────────────────────────────────────────
router.get('/agent/session/:id', requireAgent, async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);

  try {
    const { rows } = await pool.query(
      `SELECT s.*, a.nom AS agent_nom, si.nom_parking, si.ville
       FROM sessions s
       JOIN agents a ON s.agent_id = a.id
       JOIN sites si ON s.site_id = si.id
       WHERE s.id = $1 AND s.site_id = $2`,
      [sessionId, req.session.agentSiteId]
    );

    if (!rows.length) return res.redirect('/agent/sessions');

    // Notifications liées
    const { rows: notifs } = await pool.query(
      'SELECT * FROM notifications WHERE session_id = $1 ORDER BY sent_at DESC',
      [sessionId]
    );

    res.render('agent/detail_session', {
      session: rows[0], notifs,
      agentNom: req.session.agentNom, agentPrenom: req.session.agentPrenom,
      agentSite: req.session.agentSite, agentVille: req.session.agentVille
    });
  } catch (err) {
    console.error(err);
    res.redirect('/agent/sessions');
  }
});

module.exports = router;
const express    = require('express');
const bcrypt     = require('bcryptjs');
const pool       = require('../db/pool');
const router     = express.Router();
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Trop de tentatives. Réessayez dans 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false
});

const SALT_ROUNDS = 10;

// ────────────────────────────────────────────────
// PAGE CONNEXION UNIFIÉE (admin + agent)
// ────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session.userId)  return res.redirect('/dashboard');
  if (req.session.agentId) return res.redirect('/agent/dashboard');
  res.render('auth/login', {
    error: req.query.error || null,
    success: req.query.success || null,
    formData: {}
  });
});

// ────────────────────────────────────────────────
// PAGE INSCRIPTION ADMIN
// ────────────────────────────────────────────────
router.get('/signup', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('auth/signup', { error: null });
});

// ────────────────────────────────────────────────
// INSCRIPTION ADMIN
// ────────────────────────────────────────────────
router.post('/admin', async (req, res) => {
  const { nom_site, ville, nom, prenom, telephone, mot_de_passe, confirmer_mdp } = req.body;

  if (!nom_site || !ville || !nom || !prenom || !telephone || !mot_de_passe) {
    return res.render('auth/signup', { error: 'Tous les champs sont obligatoires.' });
  }
  if (mot_de_passe !== confirmer_mdp) {
    return res.render('auth/signup', { error: 'Les mots de passe ne correspondent pas.' });
  }
  if (mot_de_passe.length < 6) {
    return res.render('auth/signup', { error: 'Le mot de passe doit contenir au moins 6 caractères.' });
  }

try {
  const hash = await bcrypt.hash(mot_de_passe, SALT_ROUNDS);
  const { rows } = await pool.query(
    'INSERT INTO sites (nom_parking, ville, nom, prenom, telephone, mot_de_passe) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [nom_site.trim(), ville.trim(), nom.trim(), prenom.trim(), telephone.trim(), hash]
  );

  // Tarif par défaut : 100F au forfait "garde", actif dès la création du compte
  await pool.query(
    `INSERT INTO tarifs (site_id, prix_par_heure, prix_minimum, mode_tarifaire, prix_tarif, heure_debut, actif)
     VALUES ($1, 0, 100, 'garde', 100, 0, TRUE)`,
    [rows[0].id]
  );

  res.redirect('/login?success=Compte créé avec succès ! Connectez-vous.');
} catch (err) {
    console.error(err);
    const msg = err.code === '23505'
      ? 'Ce numéro de téléphone est déjà utilisé.'
      : 'Erreur lors de l\'inscription, réessayez.';
    res.render('auth/signup', { error: msg });
  }
});

// ────────────────────────────────────────────────
// LOGIN ADMIN
// ────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  const { telephone, mot_de_passe } = req.body;

  if (!telephone || !mot_de_passe) {
    return res.render('auth/login', {
      error: 'Téléphone et mot de passe sont requis.',
      success: null, formData: { telephone }
    });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM sites WHERE telephone = $1 LIMIT 1',
      [telephone.trim()]
    );

    if (!rows.length) {
      return res.render('auth/login', {
        error: 'Téléphone ou mot de passe invalide.',
        success: null, formData: { telephone }
      });
    }

    const user = rows[0];
    const passwordOk = user.mot_de_passe && user.mot_de_passe.startsWith('$2')
      ? await bcrypt.compare(mot_de_passe, user.mot_de_passe)
      : false;

    if (!passwordOk) {
      return res.render('auth/login', {
        error: 'Téléphone ou mot de passe invalide.',
        success: null, formData: { telephone }
      });
    }

    req.session.userId     = user.id;
    req.session.userNom    = user.nom;
    req.session.userPrenom = user.prenom;
    req.session.userSite   = user.nom_parking;
    req.session.userVille  = user.ville;
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.render('auth/login', {
      error: 'Erreur interne, réessayez.', success: null, formData: { telephone }
    });
  }
});

// ────────────────────────────────────────────────
// LOGOUT ADMIN
// ────────────────────────────────────────────────
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ────────────────────────────────────────────────
// PAGE LOGIN AGENT
// ────────────────────────────────────────────────
router.get('/agent/login', (req, res) => {
  if (req.session.agentId) return res.redirect('/agent/dashboard');
  res.render('auth/ag_login', {
    error: req.query.error || null,
    success: req.query.success || null,
    formData: {}
  });
});

// ────────────────────────────────────────────────
// LOGIN AGENT
// ────────────────────────────────────────────────
router.post('/agent/login', loginLimiter, async (req, res) => {
  const { numero, mot_de_passe } = req.body;

  if (!numero || !mot_de_passe) {
    return res.render('auth/ag_login', {
      error: 'Numéro et mot de passe sont requis.',
      success: null, formData: { numero }
    });
  }

  try {
    const { rows } = await pool.query(
      `SELECT
         a.id          AS agent_id,
         a.site_id     AS agent_site_id,
         a.nom,
         a.prenom,
         a.telephone,
         a.mot_de_passe,
         a.actif,
         s.nom_parking AS site_name,
         s.ville       AS site_ville
       FROM agents a
       JOIN sites s ON a.site_id = s.id
       WHERE a.telephone = $1 AND a.actif = TRUE AND a.deleted_at IS NULL
       LIMIT 1`,
      [numero.trim()]
    );

    if (!rows.length) {
      return res.render('auth/ag_login', {
        error: 'Numéro ou mot de passe invalide.',
        success: null, formData: { numero }
      });
    }

    const agent = rows[0];
    const passwordOk = agent.mot_de_passe && agent.mot_de_passe.startsWith('$2')
      ? await bcrypt.compare(mot_de_passe, agent.mot_de_passe)
      : false;

    if (!passwordOk) {
      return res.render('auth/ag_login', {
        error: 'Numéro ou mot de passe invalide.',
        success: null, formData: { numero }
      });
    }

    req.session.agentId        = agent.agent_id;
    req.session.agentNom       = agent.nom;
    req.session.agentPrenom    = agent.prenom;
    req.session.agentTelephone = agent.telephone;
    req.session.agentSite      = agent.site_name;
    req.session.agentVille     = agent.site_ville;
    req.session.agentSiteId    = agent.agent_site_id;
    res.redirect('/agent/dashboard');
  } catch (err) {
    console.error(err);
    res.render('auth/ag_login', {
      error: 'Erreur interne, réessayez.', success: null, formData: { numero }
    });
  }
});

// ────────────────────────────────────────────────
// LOGOUT AGENT
// ────────────────────────────────────────────────
router.get('/agent/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/agent/login'));
});
// ────────────────────────────────────────────────
// PAGE DEMANDE RESET MOT DE PASSE
// ────────────────────────────────────────────────
router.get('/reset', (req, res) => {
  res.render('auth/reset_demande', {
    error: null,
    success: null,
    role: req.query.role || 'admin'
  });
});

router.post('/reset', loginLimiter, async (req, res) => {
  const telephone = (req.body.telephone || '').trim();
  const role      = req.body.role === 'agent' ? 'agent' : 'admin';

  if (!telephone) {
    return res.render('auth/reset_demande', {
      error: 'Entrez votre numéro de téléphone.', success: null, role
    });
  }

  try {
    // Vérifier si le compte existe
    let exists;
    if (role === 'admin') {
      const r = await pool.query('SELECT id FROM sites WHERE telephone = $1', [telephone]);
      exists = r.rows.length > 0;
    } else {
      const r = await pool.query('SELECT id FROM agents WHERE telephone = $1 AND actif = TRUE', [telephone]);
      exists = r.rows.length > 0;
    }

    // On répond toujours pareil pour ne pas exposer les comptes
    if (!exists) {
      return res.render('auth/reset_demande', {
        error: null,
        success: 'Si ce numéro existe, un code de réinitialisation a été envoyé.',
        role
      });
    }

    // Générer token 6 chiffres simple (SMS-friendly)
    const token     = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    // Invalider les anciens tokens
    await pool.query(
      'UPDATE reset_tokens SET used = TRUE WHERE telephone = $1 AND role = $2 AND used = FALSE',
      [telephone, role]
    );

    await pool.query(
      'INSERT INTO reset_tokens (telephone, token, role, expires_at) VALUES ($1, $2, $3, $4)',
      [telephone, token, role, expiresAt]
    );

    // Envoyer SMS
    const { envoyerSMS } = require('../services/notification');
    await envoyerSMS(telephone,
      `SAS Parking : Votre code de réinitialisation est ${token}. Valable 30 minutes.`
    );

    console.log(`[RESET] Code pour ${telephone} (${role}) : ${token}`);

    res.redirect(`/reset/nouveau?telephone=${encodeURIComponent(telephone)}&role=${role}`);
  } catch (err) {
    console.error(err);
    res.render('auth/reset_demande', {
      error: 'Erreur interne, réessayez.', success: null, role
    });
  }
});

// ────────────────────────────────────────────────
// PAGE SAISIE NOUVEAU MOT DE PASSE
// ────────────────────────────────────────────────
router.get('/reset/nouveau', (req, res) => {
  res.render('auth/reset_nouveau', {
    error: null,
    telephone: req.query.telephone || '',
    role: req.query.role || 'admin'
  });
});

router.post('/reset/nouveau', async (req, res) => {
  const telephone    = (req.body.telephone    || '').trim();
  const token        = (req.body.token        || '').trim();
  const mot_de_passe = (req.body.mot_de_passe || '').trim();
  const confirmer    = (req.body.confirmer    || '').trim();
  const role         = req.body.role === 'agent' ? 'agent' : 'admin';

  if (!token || !mot_de_passe || !confirmer) {
    return res.render('auth/reset_nouveau', {
      error: 'Tous les champs sont requis.', telephone, role
    });
  }
  if (mot_de_passe !== confirmer) {
    return res.render('auth/reset_nouveau', {
      error: 'Les mots de passe ne correspondent pas.', telephone, role
    });
  }
  if (mot_de_passe.length < 6) {
    return res.render('auth/reset_nouveau', {
      error: 'Minimum 6 caractères.', telephone, role
    });
  }

  try {
    // Vérifier le token
    const { rows } = await pool.query(
      `SELECT * FROM reset_tokens
       WHERE telephone = $1 AND token = $2 AND role = $3
         AND used = FALSE AND expires_at > NOW()
       LIMIT 1`,
      [telephone, token, role]
    );

    if (!rows.length) {
      return res.render('auth/reset_nouveau', {
        error: 'Code invalide ou expiré. Refaites une demande.', telephone, role
      });
    }

    const hash = await bcrypt.hash(mot_de_passe, SALT_ROUNDS);

    // Mettre à jour le mot de passe
    if (role === 'admin') {
      await pool.query(
        'UPDATE sites SET mot_de_passe = $1 WHERE telephone = $2',
        [hash, telephone]
      );
    } else {
      await pool.query(
        'UPDATE agents SET mot_de_passe = $1 WHERE telephone = $2',
        [hash, telephone]
      );
    }

    // Invalider le token
    await pool.query(
      'UPDATE reset_tokens SET used = TRUE WHERE id = $1',
      [rows[0].id]
    );

    const redirectLogin = role === 'agent' ? '/agent/login' : '/login';
    res.redirect(`${redirectLogin}?success=Mot de passe réinitialisé avec succès.`);
  } catch (err) {
    console.error(err);
    res.render('auth/reset_nouveau', {
      error: 'Erreur interne, réessayez.', telephone, role
    });
  }
});
router.get('/cgu', (req, res) => {
  res.render('cgu');
});
module.exports = router;

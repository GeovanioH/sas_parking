/**
 * services/payoutService.js — SAS Parking
 * Virement journalier du CA vers chaque admin via FedaPay Transfer.
 */

const https = require('https');
const pool  = require('../db/pool');

// ─── Détection opérateur par préfixe béninois ───────────────────────────────
function detecterOperateur(telephone) {
  // Normaliser : retirer +229, 00229, 229
  const clean = telephone.replace(/^\+?(?:00)?229/, '').replace(/\D/g, '');
  const prefix2 = clean.substring(0, 2);
  const prefix1 = clean.substring(0, 1);

  // MTN Bénin : 96, 97, 66, 67, 60, 61, 62, 63
  const mtn = ['96', '97', '66', '67', '60', '61', '62', '63'];
  // Moov Bénin : 94, 95, 64, 65, 53, 54, 55, 56
  const moov = ['94', '95', '64', '65', '53', '54', '55', '56'];
  // Celtiis Bénin : 98, 68, 99, 69
  const celtiis = ['98', '68', '99', '69'];

  if (mtn.includes(prefix2))     return 'MTN';
  if (moov.includes(prefix2))    return 'MOOV';
  if (celtiis.includes(prefix2)) return 'CELTIIS';

  return null; // Opérateur inconnu
}

// ─── Formater numéro en E.164 ───────────────────────────────────────────────
function formatPhone(number) {
  number = String(number).replace(/[\s\-().]/g, '');
  if (number.startsWith('+')) return number;
  if (number.startsWith('00')) return '+' + number.slice(2);
  if (number.startsWith('229')) return '+' + number;
  // Numéro local béninois (8 chiffres)
  return '+229' + number.replace(/^0+/, '');
}

// ─── Requête HTTPS vers FedaPay ─────────────────────────────────────────────
function fedapayRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const SECRET_KEY = process.env.FEDAPAY_SECRET_KEY || '';
    const isLive     = process.env.FEDAPAY_ENV === 'live';
    const hostname   = isLive ? 'api.fedapay.com' : 'sandbox-api.fedapay.com';

    if (!SECRET_KEY || SECRET_KEY.length < 10) {
      return resolve({ simulated: true });
    }

    const data    = body ? JSON.stringify(body) : null;
    const options = {
      hostname,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${SECRET_KEY}`,
        'Content-Type':  'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };

    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ raw }); }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Créer un transfer FedaPay vers un admin ────────────────────────────────
async function creerTransfer({ telephone, montant, nom, description }) {
  const telFormate = formatPhone(telephone);
  const operateur  = detecterOperateur(telFormate);

  if (!operateur) {
    console.warn(`[PAYOUT] Opérateur inconnu pour ${telFormate} — virement annulé`);
    return { success: false, reason: 'operateur_inconnu', telephone: telFormate };
  }

  const montantFinal = Math.round(Number(montant));
  if (montantFinal <= 0) {
    return { success: false, reason: 'montant_nul' };
  }

  const body = {
    amount:      montantFinal,
    currency:    { iso: 'XOF' },
    description: description || `Reversement SAS Parking`,
    customer: {
      firstname:    nom || 'Admin',
      phone_number: {
        number:  telFormate,
        country: 'BJ'
      }
    },
    mode: operateur  // 'MTN', 'MOOV' ou 'CELTIIS'
  };

  try {
    const result = await fedapayRequest('POST', '/v1/payouts', body);

    if (result.simulated) {
      console.log(`[PAYOUT-SIM] ${nom} → ${telFormate} : ${montantFinal} FCFA simulé`);
      return { success: true, simulated: true, payoutId: `SIM-${Date.now()}` };
    }

    const payout = result['v1/payout'] || result.payout || result;
    if (payout && payout.id) {
      // Déclencher l'envoi immédiat
      await fedapayRequest('PUT', `/v1/payouts/${payout.id}/send_now`, {});
      console.log(`[PAYOUT] ✅ ${nom} → ${telFormate} : ${montantFinal} FCFA (ID: ${payout.id})`);
      return { success: true, simulated: false, payoutId: payout.id };
    }

    console.error(`[PAYOUT] Réponse inattendue:`, JSON.stringify(result));
    return { success: false, reason: 'reponse_inattendue', raw: result };

  } catch (err) {
    console.error(`[PAYOUT] Erreur réseau:`, err.message);
    return { success: false, reason: 'erreur_reseau', error: err.message };
  }
}

// ─── Virement journalier vers tous les admins ───────────────────────────────
async function lancerVirementsJournaliers() {
  const today = new Date().toISOString().split('T')[0];
  console.log(`[PAYOUT] Démarrage virements journaliers — ${today}`);

  try {
    // Récupérer tous les admins avec leur CA confirmé du jour
    const { rows: admins } = await pool.query(`
      SELECT
        s.id,
        s.nom,
        s.prenom,
        s.nom_parking,
        COALESCE(s.telephone_payout, s.telephone) AS telephone_payout,
        COALESCE(SUM(p.montant), 0) AS ca_jour
      FROM sites s
      LEFT JOIN sessions se
        ON se.site_id = s.id
        AND DATE(se.heure_sortie) = $1
        AND se.statut = 'cloture'
      LEFT JOIN paiements p
        ON p.session_id = se.id
        AND p.statut = 'confirme'
      GROUP BY s.id, s.nom, s.prenom, s.nom_parking, s.telephone, s.telephone_payout
    `, [today]);

    console.log(`[PAYOUT] ${admins.length} admin(s) trouvé(s)`);

    for (const admin of admins) {
      const ca = parseFloat(admin.ca_jour);

      if (ca <= 0) {
        console.log(`[PAYOUT] Skip ${admin.nom_parking} — CA = 0`);
        continue;
      }

      console.log(`[PAYOUT] ${admin.nom_parking} : CA = ${ca} FCFA → virement vers ${admin.telephone_payout}`);

      const result = await creerTransfer({
        telephone:   admin.telephone_payout,
        montant:     ca,
        nom:         `${admin.prenom} ${admin.nom}`,
        description: `Reversement CA du ${today} — ${admin.nom_parking}`
      });

      // Logger le résultat en DB dans la table virements
      try {
        await pool.query(`
          INSERT INTO virements (site_id, montant, telephone, statut, reference_fedapay, date_virement)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          admin.id,
          ca,
          admin.telephone_payout,
          result.success ? 'envoye' : 'echoue',
          result.payoutId ? String(result.payoutId) : null,
          today
        ]);
      } catch (logErr) {
        console.error(`[PAYOUT-LOG] Erreur insertion virement:`, logErr.message);
      }
    }

    console.log(`[PAYOUT] ✅ Virements journaliers terminés`);

  } catch (err) {
    console.error('[PAYOUT] Erreur générale:', err.message);
  }
}

module.exports = { lancerVirementsJournaliers, formatPhone, detecterOperateur };

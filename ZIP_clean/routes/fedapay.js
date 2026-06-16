const express = require('express');
const pool    = require('../db/pool');
const router  = express.Router();
const { verifierTransaction } = require('../services/paymentService');

// Webhook FedaPay
router.post('/paiement/webhook', express.json(), async (req, res) => {
  const event = req.body;
  if (!event || !event.name) return res.status(400).json({ error: 'Payload invalide.' });

  console.log('[FEDAPAY WEBHOOK]', event.name);

  if (event.name === 'transaction.approved') {
    const transaction = event.data && event.data.object;
    if (!transaction) return res.status(200).json({ received: true });

    const sessionId = transaction.meta && transaction.meta.session_id;
    const reference = String(transaction.klass_id || transaction.id);
    const montant   = transaction.amount;

    if (sessionId) {
      try {
        // Vérification idempotency — ne pas traiter deux fois la même transaction
        const { rows: existing } = await pool.query(
          `SELECT id FROM paiements WHERE reference_fedapay = $1 AND statut = 'confirme' LIMIT 1`,
          [reference]
        );
        if (existing.length > 0) {
          console.log(`[WEBHOOK] Transaction ${reference} déjà traitée — ignorée`);
          return res.status(200).json({ received: true });
        }

        // Insérer le paiement confirmé
        await pool.query(
          `INSERT INTO paiements (session_id, montant, mode, statut, reference_fedapay, paid_at)
           VALUES ($1, $2, 'mobile_money', 'confirme', $3, NOW())
           ON CONFLICT (reference_fedapay) DO UPDATE SET statut = 'confirme', paid_at = NOW()`,
          [sessionId, montant, reference]
        );

        // Clôturer la session et récupérer les infos pour le PDF
        const { rows: sessRows } = await pool.query(
          `UPDATE sessions SET statut = 'cloture', heure_sortie = COALESCE(heure_sortie, NOW()),
                               montant = COALESCE(NULLIF(montant, 0), $2)
           WHERE id = $1 AND statut != 'cloture'
           RETURNING *`,
          [sessionId, montant]
        );

        // [M3] Générer le PDF reçu pour les paiements Mobile Money
        if (sessRows.length > 0) {
          const sess = sessRows[0];
          try {
            const { genererRecuPDF } = require('../services/ticket');
            const siteRes = await pool.query('SELECT * FROM sites WHERE id = $1', [sess.site_id]);
            const tarifRes = await pool.query(
              'SELECT * FROM tarifs WHERE site_id = $1 AND actif = TRUE ORDER BY created_at DESC LIMIT 1',
              [sess.site_id]
            );
            const site  = siteRes.rows[0]  || null;
            const tarif = tarifRes.rows[0] || null;
            const pdfData = await genererRecuPDF(
              { ...sess, mode_paiement: 'mobile_money' },
              site,
              tarif
            );
            if (pdfData && pdfData.base64) {
              await pool.query(
                `UPDATE sessions SET pdf_recu = $1 WHERE id = $2`,
                [pdfData.base64, sessionId]
              );
              console.log(`[WEBHOOK PDF] Reçu généré pour session #${sessionId}`);
            }
          } catch (pdfErr) {
            console.error('[WEBHOOK PDF] Erreur génération PDF:', pdfErr.message);
          }

          // Envoyer SMS de sortie
          if (sess.telephone_client) {
            try {
              const { notifierSortie } = require('../services/notification');
              await notifierSortie({ ...sess, heure_sortie: sess.heure_sortie }, montant);
            } catch (smsErr) {
              console.error('[WEBHOOK SMS]', smsErr.message);
            }
          }
        }

      } catch (err) {
        console.error('[WEBHOOK INSERT]', err.message);
      }
    }
  }

  res.status(200).json({ received: true });
});

// Callback navigateur après paiement
router.get('/paiement/callback', (req, res) => {
  if (req.session.agentId) {
    if (req.query.status === 'approved') return res.redirect('/agent/sessions?success=Paiement confirmé.');
    return res.redirect('/agent/sessions?error=' + encodeURIComponent('Paiement non confirmé.'));
  }
  res.redirect('/login');
});

module.exports = router;

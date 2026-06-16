/**
 * services/ticket.js — SAS Parking v2.0
 * Génération de reçus PDF avec PDFKit
 * Stockage en base de données (base64) + fichier temporaire
 */
const path = require('path');
const fs   = require('fs');

/**
 * Génère un reçu PDF en mémoire et retourne le buffer + base64
 * Fonctionne sans PDFKit si non installé (fallback HTML)
 */
async function genererRecuPDF(session, site, tarif) {
  let PDFDocument;
  try {
    PDFDocument = require('pdfkit');
  } catch (e) {
    // PDFKit non disponible — retourner null
    console.warn('[PDF] PDFKit non disponible — reçu ignoré');
    return null;
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A6', margins: { top: 30, bottom: 30, left: 30, right: 30 } });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end',  () => {
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');
        resolve({ buffer, base64, mimeType: 'application/pdf' });
      });
      doc.on('error', reject);

      // ─── HEADER ───────────────────────────────
      doc.rect(0, 0, doc.page.width, 80).fill('#22c55e');

      doc.fill('#ffffff')
         .fontSize(16).font('Helvetica-Bold')
         .text('SAS PARKING', 30, 18, { align: 'center' })
         .fontSize(9).font('Helvetica')
         .text('"La garde, simplifiée."', 30, 38, { align: 'center' })
         .fontSize(8)
         .text(`${site ? site.nom_parking : 'Parking'} — ${site ? site.ville : ''}`, 30, 54, { align: 'center' });

      // ─── TITRE ────────────────────────────────
      doc.fill('#166534').fontSize(12).font('Helvetica-Bold')
         .text('REÇU DE STATIONNEMENT', 30, 95, { align: 'center' });

      // ─── LIGNE SÉPARATRICE ────────────────────
      doc.moveTo(30, 115).lineTo(doc.page.width - 30, 115).strokeColor('#22c55e').lineWidth(1.5).stroke();

      // ─── CODE HEX ─────────────────────────────
      doc.fill('#166534').fontSize(9).font('Helvetica-Bold')
         .text('CODE DE RÉCUPÉRATION', 30, 125, { align: 'center' });
      doc.rect(80, 135, doc.page.width - 160, 26).fill('#f0fdf4').stroke('#22c55e');
      doc.fill('#15803d').fontSize(14).font('Courier-Bold')
         .text(session.code_hex || '----', 30, 140, { align: 'center' });

      // ─── INFORMATIONS ─────────────────────────
      let y = 175;
      const ligne = (label, valeur, couleurVal = '#1f2937') => {
        doc.fill('#6b7280').fontSize(8).font('Helvetica')
           .text(label, 30, y);
        doc.fill(couleurVal).font('Helvetica-Bold')
           .text(String(valeur), 30, y, { align: 'right', width: doc.page.width - 60 });
        y += 16;
      };

      // Séparateur
      const sep = () => {
        doc.moveTo(30, y).lineTo(doc.page.width - 30, y).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
        y += 8;
      };

      // Client
      const nomClient = [session.nom_client, session.prenom_client].filter(Boolean).join(' ') || 'N/A';
      ligne('Client', nomClient);
      if (session.telephone_client) ligne('Téléphone', session.telephone_client);
      ligne('Plaque', session.plaque, '#15803d');
      sep();

      // Timing
      const entree  = session.heure_entree ? new Date(session.heure_entree) : new Date();
      const sortie  = session.heure_sortie ? new Date(session.heure_sortie) : new Date();
      const dureeMs = sortie - entree;
      const heures  = Math.floor(dureeMs / 3600000);
      const minutes = Math.floor((dureeMs % 3600000) / 60000);
      const dureeStr = heures > 0 ? `${heures}h ${minutes}min` : `${minutes}min`;

      ligne('Entrée',  entree.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }));
      ligne('Sortie',  sortie.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }));
      ligne('Durée',   dureeStr, '#15803d');
      sep();

      // Paiement
      const montant = Number(session.montant || 0);
      const mode    = session.mode_paiement === 'mobile_money' ? 'Mobile Money' : 'Espèces';
      ligne('Mode',    mode);
      if (tarif) {
        const tarifLabel = tarif.mode_tarifaire === 'heure'
          ? `${tarif.prix_tarif} FCFA/h` : `${tarif.prix_tarif} FCFA (garde)`;
        ligne('Tarif appliqué', tarifLabel);
      }

      // Montant total
      doc.rect(30, y, doc.page.width - 60, 28).fill('#f0fdf4').stroke('#22c55e');
      doc.fill('#15803d').fontSize(9).font('Helvetica')
         .text('MONTANT TOTAL', 40, y + 5);
      doc.fill('#15803d').fontSize(14).font('Helvetica-Bold')
         .text(`${montant.toLocaleString('fr-FR')} FCFA`, 40, y + 5, {
           align: 'right', width: doc.page.width - 80
         });
      y += 38;

      // ─── AGENT ────────────────────────────────
      if (session.agent_nom) {
        doc.fill('#6b7280').fontSize(7).font('Helvetica')
           .text(`Agent : ${session.agent_nom}`, 30, y, { align: 'center' });
        y += 12;
      }

      // ─── FOOTER ───────────────────────────────
      doc.moveTo(30, y).lineTo(doc.page.width - 30, y).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      y += 8;
      doc.fill('#9ca3af').fontSize(6.5).font('Helvetica')
         .text('Propulsé par FedaPay • Paiement sécurisé', 30, y, { align: 'center' })
         .text(`© ${new Date().getFullYear()} SAS Parking Bénin — Tous droits réservés`, 30, y + 10, { align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Sauvegarde le PDF base64 en base de données
 */
async function sauvegarderRecuEnDB(pool, sessionId, base64) {
  try {
    await pool.query(
      'UPDATE sessions SET pdf_recu = $1 WHERE id = $2',
      [base64, sessionId]
    );
    console.log(`[PDF] Reçu sauvegardé en DB pour session #${sessionId}`);
    return true;
  } catch (err) {
    console.error('[PDF] Erreur sauvegarde DB :', err.message);
    return false;
  }
}

/**
 * Récupère le PDF en base64 depuis la DB
 */
async function getRecuFromDB(pool, sessionId) {
  try {
    const { rows } = await pool.query(
      'SELECT pdf_recu FROM sessions WHERE id = $1',
      [sessionId]
    );
    return rows[0]?.pdf_recu || null;
  } catch (err) {
    console.error('[PDF] Erreur lecture DB :', err.message);
    return null;
  }
}

module.exports = {
  genererRecuPDF,
  sauvegarderRecuEnDB,
  getRecuFromDB
};

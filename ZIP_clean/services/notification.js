const pool = require('../db/pool');

function formatPhone(number) {
  number = String(number).replace(/[\s\-().]/g, '');
  if (number.startsWith('+')) return number;
  if (number.startsWith('00')) return '+' + number.slice(2);
  if (number.startsWith('229')) return '+' + number;
  return '+229' + number.replace(/^0+/, '');
}

async function envoyerSMS(telephone, message) {
  if (!telephone || telephone.trim() === '') {
    return { success: false, mode: 'skipped', reason: 'no_phone' };
  }

  const telFormate = formatPhone(telephone);
  const apiKey   = process.env.SMS_API_KEY;
  const username = process.env.SMS_USERNAME || 'sandbox';
  const hasReal  = apiKey && apiKey.length > 5;

  if (hasReal) {
    try {
      const AfricasTalking = require('africastalking');
      const at = AfricasTalking({ apiKey, username });
      const sms = at.SMS;
      await sms.send({
        to:      [telFormate],
        message,
        from:    process.env.SMS_SENDER_ID || undefined
      });
      console.log(`[SMS-REAL] ✅ → ${telFormate}`);
      return { success: true, mode: 'sms' };
    } catch (err) {
      console.error('[SMS-REAL] Erreur complète :', JSON.stringify(err, Object.getOwnPropertyNames(err)));
      return { success: false, mode: 'sms', error: err.message };
    }
  } else {
    console.log(`[SMS-DEV] → ${telephone} : ${message}`);
    return { success: true, mode: 'console' };
  }
}

async function logNotification(sessionId, type, message, statut) {
  try {
    await pool.query(
      `INSERT INTO notifications (session_id, type, message, statut, sent_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [sessionId, type, message, statut]
    );
  } catch (err) {
    console.error('[NOTIF-LOG] Erreur insertion :', err.message);
  }
}

async function notifierEntree(session) {
  const message =
    `SAS Parking : Bonjour ${session.nom_client || 'client'} ! ` +
    `Votre véhicule (${session.plaque}) est enregistré. ` +
    `Code de récupération : ${session.code_hex}. Conservez-le précieusement.`;
  const result = await envoyerSMS(session.telephone_client, message);
  await logNotification(session.id, 'sms', message, result.success ? 'envoye' : 'echoue');
  return result;
}

async function notifierSortie(session, montant) {
  const message =
    `SAS Parking : Sortie enregistrée pour la plaque ${session.plaque}. ` +
    `Montant du paiement : ${Number(montant).toLocaleString('fr-FR')} FCFA. Merci !`;
  const result = await envoyerSMS(session.telephone_client, message);
  await logNotification(session.id, 'sms', message, result.success ? 'envoye' : 'echoue');
  return result;
}

async function getNotificationsBySession(sessionId) {
  const { rows } = await pool.query(
    'SELECT * FROM notifications WHERE session_id = $1 ORDER BY sent_at DESC',
    [sessionId]
  );
  return rows;
}

module.exports = { envoyerSMS, notifierEntree, notifierSortie, logNotification, getNotificationsBySession };
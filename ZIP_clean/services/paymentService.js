const https = require('https');

const FEDAPAY_BASE = process.env.FEDAPAY_ENV === 'live'
  ? 'https://api.fedapay.com/v1'
  : 'https://sandbox-api.fedapay.com/v1';

const SECRET_KEY = process.env.FEDAPAY_SECRET_KEY || '';

function fedapayRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!SECRET_KEY || SECRET_KEY.length < 10) {
      return resolve({ simulated: true });
    }

    const data    = body ? JSON.stringify(body) : null;
    const url     = new URL(FEDAPAY_BASE + path);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
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

async function creerTransaction({ montant, telephone, description, sessionId }) {
  // Guard : montant doit être > 0
  const montantFinal = Math.round(Number(montant) || 0);
  if (montantFinal <= 0) {
    console.warn(`[FEDAPAY] Montant invalide (${montant}) — passage en simulation`);
    return { success: true, simulated: true, transactionId: `SIM-${Date.now()}` };
  }

 const body = {
    description,
    amount:       montantFinal,
    currency:     { iso: 'XOF' },
    callback_url: process.env.FEDAPAY_CALLBACK_URL,
    customer:     { phone_number: { number: telephone, country: 'BJ' } },
    meta:         { session_id: sessionId }
  };

  const result = await fedapayRequest('POST', '/transactions', body);

  if (result.simulated) {
    console.log(`[FEDAPAY-SIM] Session #${sessionId} : ${montant} FCFA simulé`);
    return { success: true, simulated: true, paymentUrl: null, transactionId: `SIM-${Date.now()}` };
  }

  // FedaPay retourne v1.transaction avec un token
  const transaction = result['v1/transaction'];  if (!transaction) {
    console.error('[FEDAPAY] Réponse inattendue:', JSON.stringify(result));
    return { success: false, error: result };
  }

  // Construire le lien de paiement
  const baseCheckout = process.env.FEDAPAY_ENV === 'live'
    ? 'https://checkout.fedapay.com'
    : 'https://sandbox-checkout.fedapay.com';

  const paymentUrl = transaction.payment_url;

  console.log(`[FEDAPAY] Transaction créée #${transaction.id} → ${paymentUrl}`);
  return { success: true, simulated: false, paymentUrl, transactionId: transaction.id };
}

async function verifierTransaction(transactionId) {
  if (String(transactionId).startsWith('SIM-')) {
    return { success: true, simulated: true, statut: 'confirme' };
  }
  const result = await fedapayRequest('GET', `/transactions/${transactionId}`, null);
  return result;
}

module.exports = { creerTransaction, verifierTransaction };
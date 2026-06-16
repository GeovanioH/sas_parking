const crypto = require('crypto');

/**
 * Génère un code HEX unique format "A3F7-C2B1"
 * Utilisé comme code de récupération client
 * @returns {string}
 */
function genererCodeHex() {
  return crypto.randomBytes(4).toString('hex').toUpperCase()
    .replace(/(.{4})(.{4})/, '$1-$2');
}

module.exports = { genererCodeHex };

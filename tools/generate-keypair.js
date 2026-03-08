/**
 * PharmaSys — ECDSA Key Pair Generator
 *
 * Run this ONCE to generate your signing keys.
 * Keep PRIVATE_KEY.pem secret — never share it, never commit it to git.
 * The PUBLIC_KEY.pem content is already embedded in src/license/license-validator.ts.
 *
 * Usage:
 *   node tools/generate-keypair.js
 *
 * Output:
 *   tools/PRIVATE_KEY.pem  — YOUR SECRET KEY (back this up somewhere safe)
 *   tools/PUBLIC_KEY.pem   — Safe to view; already embedded in the app
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const outDir = __dirname;

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const privPath = path.join(outDir, 'PRIVATE_KEY.pem');
const pubPath  = path.join(outDir, 'PUBLIC_KEY.pem');

fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
fs.writeFileSync(pubPath,  publicKey);

console.log('');
console.log('✅ Key pair generated successfully!');
console.log('');
console.log(`  Private key: ${privPath}`);
console.log(`  Public key:  ${pubPath}`);
console.log('');
console.log('IMPORTANT NEXT STEPS:');
console.log('  1. KEEP tools/PRIVATE_KEY.pem SECRET. Back it up offline (USB drive/password manager).');
console.log('  2. NEVER commit PRIVATE_KEY.pem to git. (It is already in .gitignore)');
console.log('  3. Copy the content of PUBLIC_KEY.pem into src/license/license-validator.ts');
console.log('     → Replace the PUBLIC_KEY constant with the new key.');
console.log('  4. Rebuild the app: npm run build');
console.log('');
console.log('Public key (copy this into license-validator.ts):');
console.log('─'.repeat(60));
console.log(publicKey.trim());
console.log('─'.repeat(60));

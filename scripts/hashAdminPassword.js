import crypto from 'node:crypto';

const password = process.env.ADMIN_PASSWORD_INPUT;
if (!password || password.length < 12) {
  console.error('Set ADMIN_PASSWORD_INPUT to a password with at least 12 characters.');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const derived = crypto.scryptSync(password, salt, 64);
process.stdout.write(`${salt.toString('hex')}:${derived.toString('hex')}`);

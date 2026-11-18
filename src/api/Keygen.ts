import { exportJWK, generateKeyPair } from "jose";

/**
 * Print a fresh private Ed25519 JWK for LANDPOT_JWT_KEY. Keep it secret; the
 * game server reads only the public half, from /.well-known/jwks.json.
 * Rotating it signs every session out, and game servers need a restart to
 * pick up the new JWKS.
 */
const { privateKey } = await generateKeyPair("EdDSA", {
  crv: "Ed25519",
  extractable: true,
});
console.log(JSON.stringify(await exportJWK(privateKey)));

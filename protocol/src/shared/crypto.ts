import nacl from "tweetnacl";

/**
 * Encrypted failure reports. A report is sealed to the sponsor's X25519
 * public key with a fresh ephemeral key, so only the holder of the sponsor's
 * secret key can open it. The verifier reads the plaintext only while
 * reproducing the case; it stores the sealed form.
 */
export type SealedReport = { v: 1; alg: "x25519-xsalsa20-poly1305"; epk: string; nonce: string; ct: string };

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export function generateReportKeyPair() {
  const kp = nacl.box.keyPair();
  return { publicKey: b64(kp.publicKey), secretKey: b64(kp.secretKey) };
}

export function isReportKey(value: string): boolean {
  try {
    return unb64(value).length === nacl.box.publicKeyLength;
  } catch {
    return false;
  }
}

export function seal(plaintext: string, recipientPublicKey: string): SealedReport {
  const pk = unb64(recipientPublicKey);
  if (pk.length !== nacl.box.publicKeyLength) throw new Error("report key must be a 32-byte X25519 public key");
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(new TextEncoder().encode(plaintext), nonce, pk, eph.secretKey);
  return { v: 1, alg: "x25519-xsalsa20-poly1305", epk: b64(eph.publicKey), nonce: b64(nonce), ct: b64(ct) };
}

export function open(report: SealedReport, recipientSecretKey: string): string {
  const out = nacl.box.open(unb64(report.ct), unb64(report.nonce), unb64(report.epk), unb64(recipientSecretKey));
  if (!out) throw new Error("could not decrypt: wrong key or corrupted report");
  return new TextDecoder().decode(out);
}

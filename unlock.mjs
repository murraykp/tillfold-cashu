import { verifyEvent } from './vendor/verify.mjs';

// Verify the encrypted event before asking the extension to show its plaintext.
export function extensionUnlock(signer) {
  let owner;
  return async event => {
    if (event.kind !== 7376 || typeof event.content !== 'string' ||
        !Array.isArray(event.tags) || !verifyEvent({...event})) {
      throw new Error('The encrypted event has an invalid Nostr ID or signature.');
    }
    if (!signer?.getPublicKey || !signer.nip44?.decrypt) {
      throw new Error('To open encrypted history, enable a NIP-07 extension that supports NIP-44 or import a decrypted history export.');
    }
    owner ??= await signer.getPublicKey();
    if (event.pubkey !== owner) throw new Error('This event belongs to a different wallet than the selected signer.');
    return signer.nip44.decrypt(owner,event.content);
  };
}

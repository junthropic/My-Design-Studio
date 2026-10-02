import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateSignatureEvidence,
  verificationEnvironment,
  inspectSignature,
  inspectAuthenticode,
  discoverSignTool,
  isTrustedMicrosoftTool,
  SignatureVerificationError,
} from '../scripts/signature-evidence.mjs';

const sha256 = '2.16.840.1.101.3.4.2.1',
  sha1 = '1.3.14.3.2.26',
  rsa = '1.2.840.113549.1.1.1';
const microsoft = {
  status: 'Valid',
  publicKeyOID: rsa,
  signerSubject: 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US',
  signerPublisher: 'Microsoft Corporation',
  signerThumbprint: 'AB'.repeat(20),
};
function fixture() {
  return {
    file: 'fixture.exe',
    isPE: true,
    unchanged: true,
    authenticode: {
      status: 'Valid',
      publicKeyOID: rsa,
      signerThumbprint: 'CD'.repeat(20),
      signerPublisher: 'Sample Studio',
    },
    signTool: { status: 'Valid', exitCode: 0, toolTrusted: true },
    pe: {
      parseErrors: [],
      signatures: [
        {
          fileDigestOID: sha256,
          signatureDigestOID: sha256,
          publicKeyOID: rsa,
          certificateSignatureOID: '1.2.840.113549.1.1.12', // SHA384 on cert is unrelated.
          signerThumbprint: 'CD'.repeat(20),
          signatureValid: true,
          parseErrors: [],
          timestamps: [
            {
              type: 'RFC3161',
              digestOID: sha256,
              signatureValid: true,
              imprintMatches: true,
              chainValid: true,
            },
          ],
        },
      ],
    },
  };
}
test('modern signature passes from the actual CMS file, signer and timestamp digests', () => {
  const e = evaluateSignatureEvidence(fixture());
  assert.equal(e.productionReady, true);
  assert.equal(e.preservationReady, true);
  assert.equal(e.fileDigestOID, sha256);
  assert.equal(e.signatureDigestOID, sha256);
  assert.equal(e.signerPublisher, 'Sample Studio');
  assert.deepEqual(e.issues, []);
});
test('a SHA256-signed certificate does not make a SHA1 file digest acceptable', () => {
  const f = fixture();
  f.pe.signatures[0].certificateSignatureOID = '1.2.840.113549.1.1.11';
  f.pe.signatures[0].fileDigestOID = sha1;
  const e = evaluateSignatureEvidence(f);
  assert.equal(e.sha256, false);
  assert.equal(e.productionReady, false);
  assert.equal(e.preservationReady, true);
});
test('CMS SignerInfo digest must also be SHA256', () => {
  const f = fixture();
  f.pe.signatures[0].signatureDigestOID = sha1;
  assert.equal(evaluateSignatureEvidence(f).productionReady, false);
});
test('valid historical vendor timestamp is preserved without claiming modern signing policy', () => {
  const f = fixture();
  f.pe.signatures[0].timestamps = [
    { type: 'Authenticode', digestOID: sha1, signatureValid: true, imprintMatches: true },
  ];
  const e = evaluateSignatureEvidence(f);
  assert.equal(e.preservationReady, true);
  assert.equal(e.timestampValid, true);
  assert.equal(e.rfc3161, false);
  assert.equal(e.productionReady, false);
});
test('RFC3161 presence alone cannot pass an unbound, broken or untrusted timestamp', () => {
  for (const property of ['imprintMatches', 'signatureValid', 'chainValid']) {
    const f = fixture();
    f.pe.signatures[0].timestamps[0][property] = false;
    assert.equal(evaluateSignatureEvidence(f).productionReady, false, property);
  }
});
test('timestamp messageImprint SHA1 fails even when the TSA signer digest says SHA256', () => {
  const f = fixture();
  Object.assign(f.pe.signatures[0].timestamps[0], { digestOID: sha1, signerDigestOIDs: [sha256] });
  assert.equal(evaluateSignatureEvidence(f).timestampSha256, false);
  assert.equal(evaluateSignatureEvidence(f).productionReady, false);
});
test('SignTool warning, failure, unavailability, or unauthenticated executable fail closed', () => {
  for (const signTool of [
    { status: 'Invalid', exitCode: 2, toolTrusted: true },
    { status: 'Invalid', exitCode: 1, toolTrusted: true },
    { status: 'Unavailable', exitCode: null },
    { status: 'Valid', exitCode: 0, toolTrusted: false },
  ]) {
    const e = evaluateSignatureEvidence({ ...fixture(), signTool });
    assert.equal(e.chainValid, false);
    assert.equal(e.productionReady, false);
    assert.equal(e.preservationReady, false);
  }
});
test('all nested/parallel signatures must satisfy newly signed output policy', () => {
  const f = fixture();
  const other = structuredClone(f.pe.signatures[0]);
  other.fileDigestOID = sha1;
  f.pe.signatures.push(other);
  const e = evaluateSignatureEvidence(f);
  assert.equal(e.productionReady, false);
  assert.equal(e.fileDigestOID, null);
  assert.deepEqual(e.fileDigestOIDs, [sha256, sha1]);
});
test('PE, RSA, Windows trust, CMS parsing, and stable bytes are all checked', () => {
  for (const change of [
    (f) => {
      f.isPE = false;
    },
    (f) => {
      f.authenticode.status = 'HashMismatch';
    },
    (f) => {
      f.authenticode.publicKeyOID = '1.2.840.10045.2.1';
    },
    (f) => {
      f.pe.parseErrors = ['CMS_CONTENT'];
    },
    (f) => {
      f.unchanged = false;
    },
    (f) => {
      f.pe.signatures[0].signatureValid = false;
    },
  ]) {
    const f = fixture();
    change(f);
    assert.equal(evaluateSignatureEvidence(f).productionReady, false);
  }
});
test('verification child environment strips signing, cloud, proxy and Node execution secrets', () => {
  const input = {
    PATH: 'path',
    SystemRoot: 'root',
    TEMP: 'tmp',
    WIN_CSC_KEY_PASSWORD: 'SECRET',
    AZURE_CLIENT_SECRET: 'SECRET',
    NODE_OPTIONS: '--require malicious',
    PSModulePath: 'unsafe',
    HTTPS_PROXY: 'SECRET',
    STUDIO_SECRET: 'SECRET',
  };
  assert.deepEqual(verificationEnvironment(input), {
    PATH: 'path',
    SystemRoot: 'root',
    TEMP: 'tmp',
  });
  assert.equal(input.WIN_CSC_KEY_PASSWORD, 'SECRET');
});
test('Microsoft tool requires trusted Authenticode, exact organization, RSA and thumbprint', () => {
  assert.equal(isTrustedMicrosoftTool(microsoft), true);
  for (const auth of [
    { ...microsoft, status: 'NotTrusted' },
    { ...microsoft, signerSubject: 'CN=Microsoft Corporation, O=Impostor' },
    { ...microsoft, signerSubject: 'CN=Fake, O=Microsoft Corporation Fake' },
    { ...microsoft, publicKeyOID: '1.2.840.10045.2.1' },
  ])
    assert.equal(isTrustedMicrosoftTool(auth), false);
});

const temporaryDirectories = [];
afterEach(async () => {
  for (const dir of temporaryDirectories.splice(0)) {
    if (
      !path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(dir).startsWith('studio-signature-test-')
    )
      throw new Error('Unexpected test directory');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
async function temporary(_t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-signature-test-'));
  temporaryDirectories.push(dir);
  return dir;
}
async function peFile(dir, name = 'sample.exe') {
  const data = Buffer.alloc(512);
  data.writeUInt16LE(0x5a4d);
  data.writeUInt32LE(128, 60);
  data.writeUInt32LE(0x4550, 128);
  const file = path.join(dir, name);
  await fs.writeFile(file, data);
  return file;
}
test('inspection never executes target, passes precise verify flags and strips child secrets', async (t) => {
  const dir = await temporary(t);
  const file = await peFile(dir);
  const tool = await peFile(dir, 'signtool.exe');
  const calls = [];
  const runner = async (exe, args, options) => {
    calls.push({ exe, args, options });
    if (args.includes('-Command')) return { code: 0, stdout: JSON.stringify(microsoft) };
    if (args.includes('-File')) return { code: 0, stdout: JSON.stringify(fixture().pe) };
    return { code: 0, stdout: 'SECRET should not enter evidence', stderr: 'SECRET' };
  };
  const e = await inspectSignature(file, {
    signtoolPath: tool,
    production: true,
    runner,
    env: { PATH: 'x', AZURE_CLIENT_SECRET: 'SECRET' },
  });
  assert.equal(e.productionReady, true);
  assert.equal(
    calls.some((c) => c.exe === file),
    false,
  );
  const verify = calls.find((c) => c.exe === tool);
  assert.deepEqual(verify.args, ['verify', '/pa', '/all', '/v', '/tw', file]);
  assert.equal(
    calls.some((c) => c.options.env.AZURE_CLIENT_SECRET),
    false,
  );
  assert.equal(JSON.stringify(e).includes('SECRET'), false);
});
test('unavailable SignTool is inventory evidence and a public production failure', async (t) => {
  const dir = await temporary(t);
  const file = await peFile(dir);
  const runner = async (_exe, args) => ({
    code: 0,
    stdout: JSON.stringify(args.includes('-File') ? fixture().pe : microsoft),
  });
  const e = await inspectSignature(file, { cacheRoots: [], runner });
  assert.equal(e.signTool.status, 'Unavailable');
  assert.equal(e.productionReady, false);
  await assert.rejects(
    inspectSignature(file, { cacheRoots: [], production: true, runner }),
    (error) =>
      error instanceof SignatureVerificationError &&
      error.evidence.signTool.status === 'Unavailable',
  );
});
test('an untrusted neighboring SignTool DLL prevents tool execution', async (t) => {
  const dir = await temporary(t);
  const tool = await peFile(dir, 'signtool.exe');
  await peFile(dir, 'mssign32.dll');
  const runner = async (_exe, args) => ({
    code: 0,
    stdout: JSON.stringify(
      args.join(' ').includes('mssign32.dll') ? { status: 'NotSigned' } : microsoft,
    ),
  });
  assert.equal(await discoverSignTool({ explicitPath: tool, runner }), null);
});
test('native diagnostics and invalid JSON never leak through public evidence', async () => {
  const auth = await inspectAuthenticode(path.resolve('missing.exe'), {
    runner: async () => ({
      code: 1,
      stdout: 'PRIVATE_KEY_PASSWORD',
      stderr: 'AZURE_CLIENT_SECRET',
    }),
  });
  assert.equal(auth.status, 'Unavailable');
  assert.equal(JSON.stringify(auth).includes('PRIVATE'), false);
});
test('byte changes during verification fail even if both native tools report valid', async (t) => {
  const dir = await temporary(t);
  const file = await peFile(dir);
  const tool = await peFile(dir, 'signtool.exe');
  const runner = async (exe, args) => {
    if (exe === tool) {
      await fs.appendFile(file, 'changed');
      return { code: 0, stdout: '' };
    }
    return { code: 0, stdout: JSON.stringify(args.includes('-File') ? fixture().pe : microsoft) };
  };
  const e = await inspectSignature(file, { signtoolPath: tool, runner });
  assert.equal(e.unchanged, false);
  assert.equal(e.productionReady, false);
  assert.equal(e.preservationReady, false);
});

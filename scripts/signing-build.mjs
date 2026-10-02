import path from 'node:path';
import {
  createSigningSession,
  collectSigningFiles,
  readOwnershipPolicy,
} from './signing-pipeline.mjs';
import { createProductionProvider } from './signing-providers.mjs';
import { inspectSignature, discoverSignTool } from './signature-evidence.mjs';
import { installSafeNsisExtraction } from './nsis-safe-extraction.mjs';

const fail = (code) => {
  throw new Error(`Production signing stopped: ${code}`);
};

export async function configureProductionBuild({
  config,
  metadata,
  projectDir,
  env = process.env,
  providerFactory = createProductionProvider,
  inspect = inspectSignature,
  installNsis = installSafeNsisExtraction,
  discover = discoverSignTool,
  policyLoader = readOwnershipPolicy,
  sessionFactory = createSigningSession,
}) {
  const provider = await providerFactory({ env });
  // No build, provider.sign, module installation or EXE execution before credentials pass.
  await provider.preflight();
  const signtoolPath = await discover({ explicitPath: env.STUDIO_SIGNTOOL_PATH });
  if (!signtoolPath) fail('SIGNTOOL_UNAVAILABLE');
  const policy = await policyLoader();
  const outputDirectory = path.resolve(projectDir, config.directories.output);
  const installerName = `${metadata.build.productName} Setup ${metadata.version}.exe`;
  let session, appDirectory;
  const originalBefore = config.beforePack;
  config.beforePack = async (context) => {
    await originalBefore(context);
    if (session) fail('MULTIPLE_PACK_CONTEXTS_NOT_SUPPORTED');
    if (context.arch !== 1) fail('ONLY_X64_RELEASE_SUPPORTED');
    appDirectory = path.resolve(context.appOutDir);
    if (path.dirname(appDirectory) !== outputDirectory) fail('APP_OUTPUT_OUTSIDE_SIGNED_RELEASE');
    session = sessionFactory({
      appDirectory,
      outputDirectory,
      manifestPath: path.join(outputDirectory, 'signing-manifest.json'),
      provider,
      inspect: (file, options) => inspect(file, { ...options, signtoolPath }),
      policy,
      installerName,
    });
    await installNsis({
      beforeInstallerBuild: async ({ target }) => {
        if (
          target.archs.size !== 1 ||
          !Array.from(target.archs.values()).every((p) => path.resolve(p) === appDirectory)
        )
          fail('UNEXPECTED_NSIS_ARCHIVE');
        await session.completeInternals(await collectSigningFiles(appDirectory));
      },
    });
  };
  config.win.signtoolOptions = {
    signingHashAlgorithms: ['sha256'],
    publisherName: env.STUDIO_SIGNING_PUBLISHER || metadata.build.productName,
    sign: async (task) => {
      if (!session) fail('SESSION_NOT_READY');
      if (task.hash !== 'sha256' || task.isNest) fail('ONLY_SINGLE_SHA256_SIGNATURE_ALLOWED');
      const file = path.resolve(task.path);
      const rel = path.relative(appDirectory, file);
      const kind =
        !rel.startsWith('..') && !path.isAbsolute(rel)
          ? 'internal'
          : path.basename(file) === installerName
            ? 'installer'
            : 'uninstaller';
      await session.processFile(file, { kind });
    },
  };
  delete config.win.azureSignOptions;
  config.afterSign = async (context) => {
    if (!session || path.resolve(context.appOutDir) !== appDirectory) fail('SESSION_NOT_READY');
    await session.auditInternals(await collectSigningFiles(appDirectory));
  };
  config.artifactBuildCompleted = async (event) => {
    if (typeof event.file !== 'string' || !event.file.toLowerCase().endsWith('.exe')) return;
    if (!session) fail('SESSION_NOT_READY');
    await session.finish(event.file);
  };
  return config;
}

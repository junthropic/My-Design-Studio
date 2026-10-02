import fs from 'node:fs';
import path from 'node:path';
import { projectDir, localRoot, inside } from './local-common.mjs';

export function localBuilderConfig(output) {
  if (!output || !inside(path.join(localRoot, 'builds'), output))
    throw Error('LOCAL_OUTPUT_OUTSIDE_RELEASE_ROOT');
  const base = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).build;
  // Explicit allowlist: production signing hooks/provider configuration cannot leak in.
  return {
    appId: base.appId,
    productName: base.productName,
    files: base.files,
    asarUnpack: base.asarUnpack,
    extraResources: base.extraResources.map((resource) => ({
      ...resource,
      // A previous development renderer may have written this transient log in vendor/.
      filter: ['**/*', '!debug.log'],
    })),
    directories: { output: path.resolve(output) },
    forceCodeSigning: false,
    win: {
      target: 'dir',
      icon: base.win.icon,
      signExecutable: false,
      signAndEditExecutable: false,
    },
  };
}
export default () => localBuilderConfig(process.env.STUDIO_LOCAL_BUILD_DIR);

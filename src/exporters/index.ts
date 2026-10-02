import type { Project, ExportContext, ExportResult } from '../core/types.ts';
import { ProjectSchema } from '../core/schema.ts';
import { exportPowerPoint } from './pptx.ts';
import { exportTokens } from './tokens.ts';
import { exportProjectPackage, exportWebPackage } from './packages.ts';
import { exportAdapter } from './adapters.ts';
export { importProjectPackage } from './packages.ts';
export { renderWebHTML } from './web.ts';
export async function exportProject(
  input: Project,
  format: string,
  context: ExportContext,
): Promise<ExportResult> {
  const project = ProjectSchema.parse(input);
  context.onProgress?.(0, '내보내기 검증');
  switch (format) {
    case 'pptx':
      return exportPowerPoint(project, context);
    case 'web':
      return exportWebPackage(project, context);
    case 'tokens':
      return exportTokens(project, context);
    case 'project':
      return exportProjectPackage(project, context);
    case 'after-effects':
    case 'blender':
      return exportAdapter(project, context, format);
    default:
      throw new Error(`지원하지 않는 내보내기 형식: ${format}`);
  }
}

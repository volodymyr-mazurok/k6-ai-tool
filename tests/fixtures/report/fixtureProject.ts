// The project the report fixtures (load/, stress/) were "recorded" from. Shared tests use it instead of a real project:
// project/project.yaml (name `acme`) and the feature folder in project/features/.
import { fileURLToPath } from 'node:url';
import { loadProjectFrom, type Project } from '../../../runner/config.js';

export const FIXTURE_PROJECT_DIR = fileURLToPath(new URL('./project', import.meta.url));

export function loadFixtureProject(): Promise<Project> {
  return loadProjectFrom(FIXTURE_PROJECT_DIR, 'acme');
}

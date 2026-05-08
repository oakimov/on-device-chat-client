import { existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import os from 'os';

function getDefaultProfilePath() {
  if (process.platform === 'darwin') {
    return resolve(os.homedir(), 'Library/Application Support/Google/Chrome');
  }
  return null;
}

function findWeightsInProfile(profilePath) {
  if (!profilePath || !existsSync(profilePath)) return null;
  const subdirs = [
    'OptGuideOnDeviceModel',
    'OptimizationGuidePredictionModels'
  ];
  for (const subdir of subdirs) {
    const fullPath = resolve(profilePath, subdir);
    if (!existsSync(fullPath)) continue;
    const files = readdirSync(fullPath, { recursive: true });
    const weightsFile = files.find(f => f.endsWith('weights.bin'));
    if (weightsFile) {
      return resolve(fullPath, weightsFile);
    }
  }
  return null;
}

console.log(findWeightsInProfile(getDefaultProfilePath()));

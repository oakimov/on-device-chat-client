import { existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import os from 'os';

function getDefaultProfilePath() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return resolve(home, 'Library/Application Support/Google/Chrome');
  }
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA
      ? resolve(process.env.LOCALAPPDATA, 'Google/Chrome/User Data')
      : resolve(home, 'AppData/Local/Google/Chrome/User Data');
  }
  return resolve(home, '.config/google-chrome');
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

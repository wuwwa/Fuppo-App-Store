import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const help = 'Native plan: sim / device / check / archive. This module prints arguments; it never executes Xcode.';
export function parseOptions(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) return { command: 'help' };
  const [command, ...rest] = args;
  if (!['doctor', 'sim', 'device', 'check', 'archive'].includes(command)) throw new Error(`Unknown command: ${command}\n${help}`);
  const result = { command };
  const flags = { '--fresh': 'fresh', '--full': 'full', '--release': 'release', '--foundation': 'foundation', '--allow-provisioning-updates': 'provision', '--no-launch': 'noLaunch' };
  const values = { '--simulator': 'simulator', '--device': 'device', '--build-number': 'buildNumber' };
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i];
    if (option === '--case') {
      const value = rest[++i];
      if (!/^ExampleAppUITests\/test[A-Za-z0-9_]+$/.test(value || '')) throw new Error('--case needs a ExampleAppUITests/testMethod identifier.');
      (result.cases ||= []).push(`ExampleAppUITests/${value}`);
      continue;
    }
    const name = flags[option] || values[option];
    if (!name || result[name] !== undefined) throw new Error(`Unknown or repeated option: ${option}`);
    if (flags[option]) result[name] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('-')) throw new Error(`${option} needs a value.`);
      result[name] = value;
    }
  }
  if (result.full && command !== 'check') throw new Error('--full is only for check.');
  if ((result.cases || result.foundation || result.release) && command !== 'check') throw new Error('--case, --foundation and --release are only for check.');
  if (result.full && !result.release) throw new Error('Full Simulator qualification requires --release for an explicit release request.');
  if (result.release && !result.full) throw new Error('--release requires --full.');
  if (result.full && result.cases) throw new Error('Choose focused cases or full qualification, not both.');
  if (result.noLaunch && command !== 'device') throw new Error('--no-launch is only for device.');
  if (result.simulator && !['sim', 'check'].includes(command)) throw new Error('--simulator is only for sim/check.');
  if (result.device && command !== 'device') throw new Error('--device is only for device.');
  if (result.provision && !['device', 'archive'].includes(command)) throw new Error('Provisioning updates are only for signed builds.');
  if (result.buildNumber && command !== 'archive') throw new Error('--build-number is only for archive.');
  if (command === 'archive' && !/^[1-9]\d*$/.test(result.buildNumber || '')) throw new Error('archive requires --build-number with a positive integer (choose a new number for distribution).');
  if (command === 'doctor' && rest.length) throw new Error('doctor takes no options.');
  return result;
}
export function selectSimulator(list, requested) {
  const phones = Object.entries(list.devices).flatMap(([runtime, devices]) =>
    /iOS-(\d+)/.test(runtime) && Number(runtime.match(/iOS-(\d+)/)[1]) >= 26
      ? devices.filter(device => device.isAvailable && /iPhone/.test(device.deviceTypeIdentifier || device.name)) : []);
  if (requested) {
    const match = phones.find(device => device.udid === requested);
    if (!match) throw new Error('Requested iPhone Simulator is unavailable or below iOS 26.');
    return match;
  }
  const booted = phones.filter(device => device.state === 'Booted');
  if (booted.length === 1) return booted[0];
  if (phones.length === 1) return phones[0];
  throw new Error(`Choose an iPhone with --simulator UDID. Available: ${phones.map(d => `${d.name} (${d.udid}, ${d.state})`).join('; ') || 'none; install an iOS Simulator runtime in Xcode'}`);
}
export function physicalDevices(list) {
  return (list.result?.devices || []).map(device => {
    const hardware = device.properties?.hardware || device.hardwareProperties || {};
    return { name: device.properties?.state?.name || device.deviceProperties?.name, id: device.identifier,
      udid: hardware.udid, kind: hardware.deviceType, reality: hardware.reality,
      state: device.properties?.connection?.state || device.connectionProperties?.tunnelState };
  }).filter(d => d.kind === 'iPhone' && d.reality === 'physical');
}
export function selectDevice(devices, requested) {
  const available = devices.filter(d => ['connected', 'available'].includes(d.state));
  const selected = requested ? available.find(d => d.udid === requested || d.id === requested) : available.length === 1 ? available[0] : null;
  if (!selected) throw new Error(`Connect, unlock and trust an iPhone, enable Developer Mode, then use --device UDID if needed. Devices: ${devices.map(d => `${d.name} (${d.udid}, ${d.state})`).join('; ') || 'none'}`);
  return selected;
}
export function xcodeArguments(options, target, derived, archivePath) {
  const args = ['-project', 'ios/ExampleApp.xcodeproj', '-scheme', 'ExampleApp', '-configuration', options.command === 'archive' ? 'Release' : 'Debug', '-derivedDataPath', derived];
  if (['sim', 'check'].includes(options.command)) args.push('-destination', `platform=iOS Simulator,id=${target.udid}`, 'CODE_SIGNING_ALLOWED=NO');
  else if (options.command === 'device') args.push('-destination', `platform=iOS,id=${target.udid}`);
  else args.push('-destination', 'generic/platform=iOS', '-archivePath', archivePath, `CURRENT_PROJECT_VERSION=${options.buildNumber}`);
  if (options.provision) args.push('-allowProvisioningUpdates');
  return args;
}


if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const options=parseOptions(process.argv.slice(2));
    if (['help','doctor'].includes(options.command)) console.log(help);
    else console.log(JSON.stringify({ mode:'plan-only', options, argv:xcodeArguments(options,
      {udid:options.simulator || options.device || 'SELECT_DEVICE_UDID'}, 'build/DerivedData', 'build/ExampleApp.xcarchive') }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode=1; }
}

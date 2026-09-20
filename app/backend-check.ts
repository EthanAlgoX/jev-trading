import { SettingsStore } from "./settings";
import { probeBackend } from "./model";
const result = await probeBackend(new SettingsStore().read());
console.log(JSON.stringify(result, null, 2));
if (result.reachable === false) process.exitCode = 1;

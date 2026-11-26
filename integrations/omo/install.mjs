import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const update = process.argv.slice(2);
if (update.length > 1 || (update.length === 1 && update[0] !== "--update")) {
  throw new Error("Usage: bun integrations/omo/install.mjs [--update]");
}
const agent = process.env.PRIME_OMO_AGENT_DIR ?? join(homedir(), ".prime", "agent");
const names = ["models.json", "auth.json", "settings.json", "omo-credentials.mjs", "qwen-subscription.mjs"];
if (!update.length && names.some((name) => existsSync(join(agent, name)))) {
  throw new Error("Existing Prime configuration preserved. Review this integration, then use --update to back up and replace its configuration files.");
}
mkdirSync(agent, { recursive: true, mode: 0o700 });
chmodSync(agent, 0o700);
const backup = join(agent, `omo-backup-${randomUUID()}`);
if (names.some((name) => existsSync(join(agent, name)))) {
  mkdirSync(backup, { mode: 0o700 });
  for (const name of names) {
    if (!existsSync(join(agent, name))) continue;
    copyFileSync(join(agent, name), join(backup, name));
    chmodSync(join(backup, name), 0o600);
  }
  console.log(`Previous configuration: ${backup}`);
}
// Install code only. The generator reads Omo credentials but renders references,
// never their values. Native Qwen grants remain in their existing private file.
for (const name of ["omo-credentials.mjs", "qwen-subscription.mjs"]) {
  copyFileSync(join(import.meta.dir, name), join(agent, name));
  chmodSync(join(agent, name), 0o600);
}
const child = Bun.spawn([process.execPath, join(import.meta.dir, "configure-prime-omo.mjs"), "--render"], {
  env: { ...process.env, PRIME_OMO_AGENT_DIR: agent },
  stdout: "pipe", stderr: "pipe",
});
const [output, error, code] = await Promise.all([
  new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
]);
if (code !== 0) throw new Error(`Configuration generation failed; original JSON files are unchanged.\n${error}`);
const desired = JSON.parse(output);
for (const [name, config] of Object.entries(desired)) {
  // Preserve unrelated application preferences; provider/default settings update.
  const path = join(agent, name);
  const value = name === "settings.json" && existsSync(path)
    ? { ...JSON.parse(readFileSync(path, "utf8")), ...config } : config;
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
console.log(`Installed Omo provider integration in ${agent}`);

// Offline test-only resolution of Pi's peer packages. Never loaded by the extension.
// No npm install, copied Pi core, production credentials, or provider requests.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const hostRoot = process.env.PI_ROTATOR_HOST_ROOT;
assert.ok(hostRoot, "Set PI_ROTATOR_HOST_ROOT to the installed pi-coding-agent package directory");
const parentURL = pathToFileURL(join(hostRoot, "package.json")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^@earendil-works\/(?:pi-ai|pi-coding-agent)(?:\/|$)/u.test(specifier)) {
      return nextResolve(specifier, { ...context, parentURL });
    }
    return nextResolve(specifier, context);
  },
});

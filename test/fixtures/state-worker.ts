import { JsonFileStateStore } from "../../src/state-store.ts";

interface CounterState { count: number }

const [mode, stateFile, iterationsRaw] = process.argv.slice(2);
if (!mode || !stateFile) throw new Error("mode and stateFile are required");
const iterations = Number(iterationsRaw ?? "1");

function barrier(): Promise<void> {
  process.stdout.write("READY\n");
  return new Promise(() => {
    // Keep the worker itself alive until its parent terminates it.
    setInterval(() => undefined, 1_000);
  });
}

const store = new JsonFileStateStore<CounterState>({
  stateFile,
  initialState: () => ({ count: 0 }),
  lockTimeoutMs: mode === "blocked-reclaim" ? 250 : 10_000,
  staleLockMs: 200,
  ...(mode === "crash-state"
    ? { faultHooks: { afterStateCandidateSynced: barrier } }
    : mode === "crash-lock-candidate"
      ? { faultHooks: { afterLockCandidateSynced: barrier } }
      : mode === "crash-reaper"
        ? { faultHooks: { afterStaleClaimValidated: barrier } }
        : {}),
});

let activeIteration: number | undefined;
try {
  if (mode === "increment") {
    for (let index = 0; index < iterations; index += 1) {
      activeIteration = index;
      await store.transact(async (state) => {
        const before = state.count;
        await new Promise((resolve) => setTimeout(resolve, index % 3));
        state.count = before + 1;
      });
    }
    process.stdout.write("DONE\n");
  } else if (mode === "blocked-reclaim") {
    await store.transact((state) => {
      state.count += 1;
    });
  } else if (mode === "hold-lock") {
    await store.transact(async () => barrier());
  } else if (mode === "crash-state") {
    await store.transact((state) => {
      state.count += 1;
    });
  } else if (mode === "crash-lock-candidate" || mode === "crash-reaper") {
    await store.transact((state) => {
      state.count += 1;
    });
  } else if (mode === "diagnostic-hang") {
    process.stdout.write(`${"o".repeat(20_000)}\nSTDOUT_TAIL\n`);
    process.stderr.write(`${"e".repeat(20_000)}\nSTDERR_TAIL\n`);
    await barrier();
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} catch (error) {
  const source = error instanceof Error
    ? error as Error & NodeJS.ErrnoException & { dest?: string }
    : undefined;
  process.stderr.write(`${JSON.stringify({
    mode,
    activeIteration,
    name: source?.name ?? "NonErrorThrow",
    message: source?.message ?? String(error),
    code: source?.code,
    errno: source?.errno,
    syscall: source?.syscall,
    path: source?.path,
    dest: source?.dest,
    stack: source?.stack?.slice(0, 8_192),
  })}\n`);
  process.exitCode = 1;
}

#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  // The default XS machine is sized for a small mod and this one does not fit:
  // with the defaults, loading the mod dies in fxAbort ("memory full") before
  // main.js runs a line. There is ~122KB of app heap, so buy room from it.
  //
  // All three sizes must be set together — the firmware rejects the record as
  // invalid if only some are non-zero, and a rejected record silently falls
  // back to the defaults that already failed.
  //
  // Slots hold objects, closures and module records: three modules, a screen
  // object per flow, a closure per picker. Chunks hold strings and arrays: the
  // event log, and the JSON blob written to flash on every event. What is left
  // over still has to cover AppMessage's buffers, which is why the phone export
  // asks for small ones instead of taking the default maximum.
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 6 * 1024,
    .slot = 48 * 1024,
    .chunk = 24 * 1024,
#ifdef PBL_DEBUG
    // Built with `pebble build --debug`: enable the xsbug JavaScript debugger.
    // kModdableCreationFlagLogInstrumentation is the other useful one here — it
    // streams slot/chunk/stack usage once a second, which is how the sizes
    // above were chosen.
    .flags = kModdableCreationFlagDebug,
#endif
  };
  moddable_createMachine(&cr);

  window_destroy(w);
}

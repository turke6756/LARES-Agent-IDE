// lares-native (non-Windows stub) — the Job Object surface is Windows-only.
//
// On non-Windows platforms the addon still compiles and loads cleanly, but every
// call throws a clear "unsupported platform" error and platformSupported() is
// false. In practice index.js does not even require the binary off Windows (it
// returns a pure-JS no-op surface); this stub exists so `node-gyp` builds
// succeed on any OS and the ABI story stays uniform.

#include <node_api.h>

namespace {

napi_value Unsupported(napi_env env, napi_callback_info /*cbi*/) {
  napi_throw_error(env, nullptr, "lares-native: Windows Job Object surface is not supported on this platform");
  return nullptr;
}

napi_value PlatformSupported(napi_env env, napi_callback_info /*cbi*/) {
  napi_value res;
  napi_get_boolean(env, false, &res);
  return res;
}

napi_value Init(napi_env env, napi_value exports) {
  const char* names[] = {
    "createNamedJob", "openNamedJob", "assignPid", "listJobPids",
    "terminateJob", "pidCreationTime", "getCommitStatus",
  };
  for (const char* name : names) {
    napi_value fn;
    napi_create_function(env, name, NAPI_AUTO_LENGTH, Unsupported, nullptr, &fn);
    napi_set_named_property(env, exports, name, fn);
  }
  napi_value ps;
  napi_create_function(env, "platformSupported", NAPI_AUTO_LENGTH, PlatformSupported, nullptr, &ps);
  napi_set_named_property(env, exports, "platformSupported", ps);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
